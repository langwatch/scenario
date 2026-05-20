"""
Regression: the example Pipecat stub bot must NOT cancel its own STT/LLM
pipeline when trailing user audio arrives after a VAD-driven flush.

Real bug reproduction (examples/voice/angry_customer.py):
    1. User simulator streams ~6.5s of paced angry-customer audio with a
       natural pause between tonal markers.
    2. Bot's VAD detects 300ms silence mid-utterance → flushes 44KB to
       STT (response_task = _process_user_audio).
    3. The remaining tail of the same paced audio keeps arriving.
    4. VAD flips back to speech_started=True → _maybe_barge_in cancels
       the in-flight response_task. But the bot is still STT-ing, not
       TTS-ing. There is nothing for the user to "barge into".
    5. utterance_end mark fires the second flush over a 7KB tail slice
       that transcribes to empty → bot stays silent → scenario times out.

The legitimate barge-in semantic is "the user is talking over the bot's
speech". That implies the bot must actually be emitting audio. This test
locks that contract in.
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
import time
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))

import _bot.bot as bot_module  # type: ignore[import]


MULAW_FRAME_BYTES = 160  # 20ms of µ-law 8kHz mono


class _ScriptedVad:
    """Deterministic VAD. Returns the next boolean from a script; defaults to
    False once the script is exhausted so trailing frames are treated as
    silence rather than driving fresh barge-in attempts."""

    def __init__(self, _aggressiveness: int) -> None:
        self.script: list[bool] = []

    def is_speech(self, _frame: bytes, _rate: int) -> bool:
        if not self.script:
            return False
        return self.script.pop(0)


class _FakeWebSocket:
    """Mimics the websockets server-side connection the bot iterates over."""

    _CLOSE = object()

    def __init__(self) -> None:
        self.sent: list[str] = []
        self._inbox: asyncio.Queue[Any] = asyncio.Queue()
        self.remote_address = ("test", 0)

    async def send(self, msg: str) -> None:
        self.sent.append(msg)

    def __aiter__(self) -> "_FakeWebSocket":
        return self

    async def __anext__(self) -> Any:
        item = await self._inbox.get()
        if item is _FakeWebSocket._CLOSE:
            raise StopAsyncIteration
        return item

    def feed(self, frame: str) -> None:
        self._inbox.put_nowait(frame)

    def close(self) -> None:
        self._inbox.put_nowait(_FakeWebSocket._CLOSE)


def _media_frame(stream_sid: str, payload_bytes: bytes) -> str:
    return json.dumps(
        {
            "event": "media",
            "streamSid": stream_sid,
            "media": {"payload": base64.b64encode(payload_bytes).decode("ascii")},
        }
    )


@pytest.fixture
def stubbed_bot(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Patch external dependencies of the bot module with controllable
    stubs. Returns a dict of inspection handles the test reads from."""
    import webrtcvad

    vad = _ScriptedVad(1)
    monkeypatch.setattr(webrtcvad, "Vad", lambda _aggr=0: vad)

    stt_calls: list[bytes] = []
    llm_calls: list[str] = []
    tts_calls: list[str] = []

    def stub_stt(mulaw_bytes: bytes) -> str:
        stt_calls.append(bytes(mulaw_bytes))
        # ~3000 bytes µ-law @ 8kHz = ~375ms of audio. A real STT will
        # return useful text only for buffers above the rough fragment
        # threshold; below that, Whisper returns "" in practice.
        # Slow the call slightly so the test deterministically exposes
        # the cancel-during-STT window — without a small delay the
        # executor thread can finish before the next frame hits the
        # main loop and barge-in would race against done().
        time.sleep(0.05)
        if len(mulaw_bytes) >= 3000:
            return "transcribed user utterance"
        return ""

    def stub_llm(transcript: str, _history: list[dict]) -> str:
        llm_calls.append(transcript)
        return "I understand, here is my reply."

    def stub_tts(text: str) -> bytes:
        tts_calls.append(text)
        # 200ms of PCM16 24kHz silence. Just needs to be non-empty so
        # _send_tts emits at least one media frame.
        return b"\x00" * (24000 // 5 * 2)

    monkeypatch.setattr(bot_module, "_openai_stt", stub_stt)
    monkeypatch.setattr(bot_module, "_openai_chat_response", stub_llm)
    monkeypatch.setattr(bot_module, "_openai_tts_pcm16", stub_tts)

    return {
        "vad": vad,
        "stt_calls": stt_calls,
        "llm_calls": llm_calls,
        "tts_calls": tts_calls,
    }


async def _drive_angry_customer_pattern(
    ws: _FakeWebSocket, vad: _ScriptedVad, stream_sid: str
) -> None:
    """Reproduces the audio timing of the angry_customer demo:

      1. Bot receives `connected` + `start` → greeting goes out.
      2. User speech frames arrive (40 speech frames).
      3. 300ms gap (16 silence frames) triggers VAD end-of-utterance →
         first flush, STT starts in executor.
      4. While STT is still running, 10 more speech frames arrive (the
         paced tail of the same utterance). On current code these
         re-trigger _maybe_barge_in and cancel the STT pipeline.
      5. `utterance_end` mark fires the second flush over the tail slice.
    """
    ws.feed(json.dumps({"event": "connected", "protocol": "Call", "version": "1.0.0"}))
    ws.feed(
        json.dumps(
            {
                "event": "start",
                "streamSid": stream_sid,
                "start": {
                    "streamSid": stream_sid,
                    "callSid": "CAtest",
                    "mediaFormat": {
                        "encoding": "audio/x-mulaw",
                        "sampleRate": 8000,
                        "channels": 1,
                    },
                },
            }
        )
    )

    # 40 speech frames + 16 silence (= SILENCE_FRAMES_TO_END+1) + 10 trailing speech.
    vad.script = [True] * 40 + [False] * 16 + [True] * 10

    # 40 speech frames carrying nonzero µ-law payload — content is
    # immaterial because VAD is scripted; STT only sees the buffer size.
    speech_payload = b"\x55" * MULAW_FRAME_BYTES
    silence_payload = b"\xff" * MULAW_FRAME_BYTES  # µ-law silence
    for _ in range(40):
        ws.feed(_media_frame(stream_sid, speech_payload))
    for _ in range(16):
        ws.feed(_media_frame(stream_sid, silence_payload))
    # Yield to give the bot a chance to enter STT in the executor before
    # the trailing speech frames arrive.
    await asyncio.sleep(0.01)
    for _ in range(10):
        ws.feed(_media_frame(stream_sid, speech_payload))
    ws.feed(
        json.dumps(
            {
                "event": "mark",
                "streamSid": stream_sid,
                "mark": {"name": "utterance_end"},
            }
        )
    )


@pytest.mark.asyncio
async def test_bot_does_not_cancel_stt_on_trailing_user_audio(stubbed_bot):
    """The bot must complete STT → LLM → TTS for the first flush even when
    trailing user audio re-triggers VAD speech detection. Barge-in is only
    valid when the bot is actively emitting TTS audio.

    Failure mode this test guards against: scenario.run() with a Pipecat
    bot times out after 30s with PipecatAgentAdapter TimeoutError because
    the bot silently drops the user's transcribed utterance.
    """
    ws = _FakeWebSocket()
    stream_sid = "MZtest"

    handler = asyncio.create_task(bot_module._handle_connection(ws))

    await _drive_angry_customer_pattern(ws, stubbed_bot["vad"], stream_sid)

    # Wait up to a few seconds for the bot to finish its full pipeline.
    # If barge-in cancels STT, llm_calls stays empty forever.
    deadline = asyncio.get_event_loop().time() + 5.0
    while asyncio.get_event_loop().time() < deadline:
        if stubbed_bot["llm_calls"]:
            break
        await asyncio.sleep(0.05)

    ws.close()
    await asyncio.wait_for(handler, timeout=2.0)

    assert stubbed_bot["llm_calls"], (
        "Bot never reached the LLM step — its STT pipeline was cancelled by a "
        "spurious barge-in while the bot was not TTS-ing. "
        f"stt_calls={len(stubbed_bot['stt_calls'])} "
        f"tts_calls={len(stubbed_bot['tts_calls'])}"
    )


@pytest.mark.asyncio
async def test_barge_in_still_cancels_while_bot_is_tts_ing(
    stubbed_bot, monkeypatch
):
    """Counterweight to the regression test above: barge-in MUST still
    cancel when the bot is actively emitting TTS audio. The fix narrows
    the condition; it doesn't remove the feature."""
    # Replace _send_tts with a slow one that sets bot_speaking via the
    # callback and then sleeps long enough for the user to barge in.
    async def slow_send_tts(
        websocket, stream_sid, text, history, on_speaking=None
    ):
        # Mark the bot as speaking, then linger so the test's barge-in
        # frames can arrive while we're "talking".
        if on_speaking is not None:
            on_speaking(True)
        try:
            await asyncio.sleep(2.0)
            # Pretend we sent one frame so the test sees outbound media.
            await websocket.send(
                json.dumps(
                    {
                        "event": "media",
                        "streamSid": stream_sid,
                        "media": {"payload": "AAA="},
                    }
                )
            )
        finally:
            if on_speaking is not None:
                on_speaking(False)

    monkeypatch.setattr(bot_module, "_send_tts", slow_send_tts)

    ws = _FakeWebSocket()
    stream_sid = "MZtest"

    handler = asyncio.create_task(bot_module._handle_connection(ws))

    ws.feed(json.dumps({"event": "connected", "protocol": "Call", "version": "1.0.0"}))
    ws.feed(
        json.dumps(
            {
                "event": "start",
                "streamSid": stream_sid,
                "start": {
                    "streamSid": stream_sid,
                    "callSid": "CAtest",
                    "mediaFormat": {
                        "encoding": "audio/x-mulaw",
                        "sampleRate": 8000,
                        "channels": 1,
                    },
                },
            }
        )
    )

    # Wait for greeting's slow_send_tts to start (bot_speaking becomes True).
    await asyncio.sleep(0.1)

    # Now user starts talking. VAD says speech → _maybe_barge_in should
    # cancel the greeting because bot_speaking is True.
    stubbed_bot["vad"].script = [True] * 5
    for _ in range(5):
        ws.feed(_media_frame(stream_sid, b"\x55" * MULAW_FRAME_BYTES))

    # Give the loop a moment to process and cancel.
    await asyncio.sleep(0.2)

    ws.close()
    await asyncio.wait_for(handler, timeout=3.0)

    # If barge-in fired correctly, the slow_send_tts task was cancelled
    # before its asyncio.sleep(2.0) finished — so its post-sleep
    # "media" frame never made it to ws.sent.
    media_sent = [m for m in ws.sent if '"event": "media"' in m]
    assert media_sent == [], (
        "Expected barge-in to cancel the in-flight TTS before any media "
        f"frame was emitted, but {len(media_sent)} were sent: {media_sent}"
    )
