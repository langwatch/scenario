"""
Minimal WebSocket stub bot for the @e2e voice demos.

This bot speaks the Twilio Media Streams wire protocol that
PipecatAgentAdapter expects:

  1. Client (scenario) sends: ``connected`` event
  2. Client sends: ``start`` event with stream_sid + call_sid
  3. Client sends: ``media`` events carrying base64-encoded µ-law 8 kHz audio
  4. This bot echoes a short canned greeting back as ``media`` frames, then
     waits for the conversation to proceed.
  5. When the client sends ``stop``, the bot closes the WebSocket.

Wire format: Twilio Media Streams JSON (same as TwilioFrameSerializer in
pipecat-ai).  No pipecat dependency needed — only ``websockets``, ``openai``,
and stdlib.

The bot uses OpenAI chat completions to generate text responses, then
synthesises speech via OpenAI TTS (alloy voice) and converts the resulting
audio to µ-law 8 kHz for the wire. Model defaults live in
`scenario/config/voice_models.py` so the bot tracks the rest of the SDK.

Running the bot
---------------

    cd python
    uv run python examples/voice/_bot/bot.py

Or via the Makefile shortcut (from the repo root):

    make voice-pipecat-up

The bot listens on ws://localhost:8765/stream by default.

Environment variables
---------------------
    OPENAI_API_KEY     — required for LLM + TTS
    BOT_HOST           — bind host (default: 127.0.0.1)
    BOT_PORT           — bind port (default: 8765)
    BOT_LOG_LEVEL      — Python logging level name (default: INFO)
"""

from __future__ import annotations

import argparse
import asyncio
import audioop
import base64
import json
import logging
import os
import signal
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable, Optional


# ---------------------------------------------------------------------------
# Bootstrap: load .env so OPENAI_API_KEY is available when run from python/
# ---------------------------------------------------------------------------

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")
except ImportError:
    pass  # dotenv is a scenario dep; if missing, env must already be set


from scenario.config.voice_models import (
    OPENAI_BOT_LLM_MODEL,
    OPENAI_BOT_STT_MODEL,
    OPENAI_TTS_MODEL,
)


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

_log_level_name = os.environ.get("BOT_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, _log_level_name, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("voice_pipecat_bot")


# ---------------------------------------------------------------------------
# Wire-format constants (Twilio Media Streams)
# ---------------------------------------------------------------------------

TWILIO_SAMPLE_RATE = 8000   # µ-law 8 kHz
PCM16_SAMPLE_RATE = 24000
PCM16_SAMPLE_WIDTH = 2
FRAME_MS = 20
FRAME_BYTES = TWILIO_SAMPLE_RATE * FRAME_MS // 1000  # 160 bytes per 20 ms frame


# ---------------------------------------------------------------------------
# Codec helpers
# ---------------------------------------------------------------------------


def _pcm16_to_mulaw8k(pcm16_24k: bytes) -> bytes:
    """PCM16 24 kHz mono → µ-law 8 kHz mono."""
    if not pcm16_24k:
        return b""
    pcm8k, _ = audioop.ratecv(pcm16_24k, PCM16_SAMPLE_WIDTH, 1, PCM16_SAMPLE_RATE, TWILIO_SAMPLE_RATE, None)
    return audioop.lin2ulaw(pcm8k, PCM16_SAMPLE_WIDTH)


def _mulaw8k_to_pcm16_24k(mulaw8k: bytes) -> bytes:
    """µ-law 8 kHz mono → PCM16 24 kHz mono."""
    if not mulaw8k:
        return b""
    pcm8k = audioop.ulaw2lin(mulaw8k, PCM16_SAMPLE_WIDTH)
    pcm24k, _ = audioop.ratecv(pcm8k, PCM16_SAMPLE_WIDTH, 1, TWILIO_SAMPLE_RATE, PCM16_SAMPLE_RATE, None)
    return pcm24k


def _chunk_mulaw(mulaw_bytes: bytes):
    """Yield 20 ms µ-law frames."""
    for i in range(0, len(mulaw_bytes), FRAME_BYTES):
        yield mulaw_bytes[i : i + FRAME_BYTES]


# ---------------------------------------------------------------------------
# OpenAI helpers
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You are a helpful, friendly customer-service voice assistant for a "
    "general business (account support, billing questions, hours, general "
    "inquiries). Respond substantively — if a caller asks for their "
    "balance, say something like 'Your balance is $142.50 as of today.' "
    "If a caller asks about hours, say 'We're open Monday through Friday, "
    "9 AM to 6 PM.' Make up plausible details when needed — do not deflect "
    "with 'I don't have access to that.' "
    "If a caller seems frustrated or angry, acknowledge their feelings "
    "with empathy ('I'm really sorry that happened'), then offer a concrete "
    "next step (a refund, callback, escalation to a supervisor). "
    "If a caller gives multiple requests in one turn, address each one. "
    "If background conversation bleeds in that isn't directed at you, wait "
    "quietly rather than responding. "
    "Keep each reply to 1–3 sentences — this is real-time voice. Be warm "
    "and clear. End the conversation politely when the caller says goodbye."
)


def _openai_chat_response(transcript: str, history: list[dict]) -> str:
    """
    Call OpenAI chat API synchronously. Returns assistant text.

    Falls back to a canned reply if OPENAI_API_KEY is absent or the call fails,
    so the bot stays alive (useful for debugging wire-format issues).
    """
    try:
        import openai  # already a hard dep of scenario

        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        messages.extend(history[-6:])  # keep context window small
        messages.append({"role": "user", "content": transcript})
        client = openai.OpenAI()
        resp = client.chat.completions.create(
            model=OPENAI_BOT_LLM_MODEL,
            messages=messages,  # type: ignore[arg-type]
            # GPT-5.x rejects `max_tokens` in favour of `max_completion_tokens`.
            max_completion_tokens=60,
            temperature=0.4,
        )
        return resp.choices[0].message.content or "I'm here to help you!"
    except Exception as exc:
        logger.warning("LLM call failed (%s); using canned reply", exc)
        return "Thank you for calling. How can I help you today?"


def _openai_tts_pcm16(text: str) -> bytes:
    """
    Synthesise text → PCM16 24 kHz using OpenAI TTS.

    Returns raw PCM16 bytes (24 kHz, mono).  Falls back to 500 ms of silence
    if TTS fails so the bot keeps the conversation moving.
    """
    try:
        import openai

        client = openai.OpenAI()
        resp = client.audio.speech.create(
            model=OPENAI_TTS_MODEL,
            voice="alloy",
            input=text,
            response_format="pcm",   # raw PCM16 24 kHz from OpenAI
        )
        return resp.content
    except Exception as exc:
        logger.warning("TTS call failed (%s); sending 500 ms silence", exc)
        # 500 ms of silence: 24000 samples/s * 0.5 s * 2 bytes/sample
        return b"\x00" * (PCM16_SAMPLE_RATE // 2 * PCM16_SAMPLE_WIDTH)


def _openai_stt(mulaw_bytes: bytes) -> str:
    """
    Transcribe accumulated µ-law audio via OpenAI Whisper.

    Returns empty string on failure.
    """
    if not mulaw_bytes:
        return ""
    try:
        import openai

        # Convert µ-law 8k → PCM16 24k → WAV in memory for the Whisper API.
        pcm24k = _mulaw8k_to_pcm16_24k(mulaw_bytes)
        wav_bytes = _pcm16_to_wav(pcm24k)
        client = openai.OpenAI()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp_path = f.name
            f.write(wav_bytes)
        try:
            with open(tmp_path, "rb") as fh:
                result = client.audio.transcriptions.create(
                    model=OPENAI_BOT_STT_MODEL,
                    file=fh,
                )
            text = result.text.strip()
            logger.info("STT raw text=%r (input bytes=%d)", text, len(mulaw_bytes))
            return text
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                # Tempfile already removed or never created — best-effort cleanup.
                pass
    except Exception as exc:
        logger.warning("STT call failed (%s)", exc)
        return ""


def _pcm16_to_wav(pcm16_bytes: bytes, sample_rate: int = PCM16_SAMPLE_RATE) -> bytes:
    """Wrap raw PCM16 bytes in a minimal WAV header."""
    import struct

    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = len(pcm16_bytes)
    riff_size = 36 + data_size

    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        riff_size,
        b"WAVE",
        b"fmt ",
        16,           # chunk size
        1,            # PCM = 1
        num_channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b"data",
        data_size,
    )
    return header + pcm16_bytes


# ---------------------------------------------------------------------------
# Per-connection handler
# ---------------------------------------------------------------------------


async def _handle_connection(websocket) -> None:  # type: ignore[no-untyped-def]
    """Handle one WS connection from a PipecatAgentAdapter client.

    User-turn detection: feed inbound µ-law audio into webrtcvad. Once the
    user has spoken and then stopped, fire STT on the accumulated buffer.
    The previous "trigger after 1s of bytes" approach truncated longer user
    utterances mid-sentence, causing the bot to reply "you got cut off."
    """
    import webrtcvad
    import websockets.exceptions  # noqa: F401  — imported for isinstance check below

    stream_sid: Optional[str] = None
    call_sid: Optional[str] = None
    accumulated_mulaw = bytearray()
    conversation_history: list[dict] = []
    # webrtcvad operates on PCM16 at 8/16/32/48 kHz with 10/20/30 ms frames.
    # Our incoming audio is µ-law @ 8 kHz; we decode each batch to PCM16 @ 8k
    # for VAD, but keep the µ-law version for STT (Whisper accepts WAV).
    vad = webrtcvad.Vad(1)  # aggressiveness 0–3; 1 = more permissive (TTS audio quieter than human)
    VAD_FRAME_MS = 20
    VAD_BYTES_PER_FRAME_PCM16_8K = 8000 * VAD_FRAME_MS // 1000 * 2  # 320 bytes
    speech_started = False
    pcm16_8k_buf = bytearray()
    silence_frames = 0  # contiguous non-speech frames
    # 15 frames * 20 ms = 300 ms. Lower values fire on natural inter-word
    # micro-pauses ("Hi[.] I need...") and split one utterance into two
    # turns. 300 ms rides through normal speech rhythm without splitting.
    SILENCE_FRAMES_TO_END = 15
    # If speech was detected and then NO new media frame arrives for this
    # long, treat it as end-of-utterance regardless of VAD. Catches the
    # case where TTS cuts straight to silence with no trailing breath
    # (the user simulator stops sending entirely; VAD never gets to run
    # on the trailing silence because there's no trailing silence to feed).
    # Fallback turn-detection only — primary signal is the ``utterance_end``
    # Twilio mark sent by cooperating clients (see scenario/voice/adapters/
    # pipecat.py::send_audio). These thresholds matter only if a sender
    # doesn't emit marks; they intentionally favor "wait a bit longer" over
    # "flush prematurely."
    INACTIVITY_END_MS = 1500
    MIN_BYTES_TO_PROCESS = 1600  # ~200ms µ-law; reject obvious fragments
    inactivity_task: Optional[asyncio.Task] = None
    # Tracks the in-flight STT/LLM/TTS pipeline. When VAD detects fresh user
    # speech while this is non-None AND the bot is actively TTS-ing, we
    # cancel it — that's barge-in: the user interrupts the bot mid-utterance,
    # the bot stops talking and listens.
    response_task: Optional[asyncio.Task] = None
    # True only while _send_tts is actively writing media frames to the wire.
    # Gates barge-in: cancelling response_task during the STT/LLM phase is
    # wrong (the bot hasn't said anything yet, there is nothing to barge in
    # on) and used to drop the user's first transcribed utterance on the
    # floor whenever paced trailing audio arrived after a VAD-driven flush.
    # Note that this stays False during the executor-bound TTS synthesis call
    # (the OpenAI TTS HTTP request) — the wire is still silent at that point,
    # so suppressing barge-in there is also the correct semantic.
    bot_speaking = False
    greeted = False
    # Idle re-prompt: if the caller goes quiet for IDLE_REPROMPT_MS after a
    # turn has completed, ask "Are you still there?" once. Resets when the
    # caller speaks or a new bot response starts. Demos like
    # examples/voice/silence_handling.py rely on this — AC #61.
    IDLE_REPROMPT_MS = 6000
    IDLE_REPROMPT_TEXT = "I'm sorry, are you still there?"
    last_activity_at = time.monotonic()
    idle_reprompted = False

    def _mulaw8k_chunk_to_pcm16_8k(mulaw: bytes) -> bytes:
        """µ-law @ 8k -> PCM16 @ 8k (no resample, just decode)."""
        import audioop  # type: ignore[import]
        return audioop.ulaw2lin(mulaw, 2)

    def _set_speaking(value: bool) -> None:
        """Update ``bot_speaking`` from the TTS-send loop. Gates barge-in
        so cancellation can only fire while audio is actually on the wire."""
        nonlocal bot_speaking
        bot_speaking = value

    async def _flush_user_turn() -> None:
        """Send accumulated µ-law to STT/LLM/TTS pipeline, reset buffers.

        The STT/LLM/TTS pipeline runs as a separate task tracked in
        ``response_task`` so that a subsequent barge-in (user starts talking
        again while the bot is still TTS-ing) can cancel it.
        """
        nonlocal accumulated_mulaw, pcm16_8k_buf, speech_started, silence_frames
        nonlocal inactivity_task, response_task
        if inactivity_task is not None and not inactivity_task.done():
            inactivity_task.cancel()
        inactivity_task = None
        # Skip if buffer is too small OR if no real speech was detected since
        # last reset. The latter guards against whisper hallucinating ("you",
        # "thanks", etc.) on trailing silence between turns — easy to hit
        # when a redundant utterance_end mark arrives after a VAD-driven flush.
        if (
            not speech_started
            or len(accumulated_mulaw) < MIN_BYTES_TO_PROCESS
            or not stream_sid
        ):
            accumulated_mulaw.clear()
            pcm16_8k_buf.clear()
            speech_started = False
            silence_frames = 0
            return
        audio_to_process = bytes(accumulated_mulaw)
        accumulated_mulaw.clear()
        pcm16_8k_buf.clear()
        speech_started = False
        silence_frames = 0
        # Wait for any prior in-flight response to finish (or for its barge-in
        # cancellation to settle) before starting a new one. Two responses
        # writing to the websocket concurrently would interleave audio frames.
        if response_task is not None and not response_task.done():
            try:
                _ = await response_task
            except (asyncio.CancelledError, Exception):
                # Draining the prior turn — any failure here is non-fatal.
                pass
        response_task = asyncio.create_task(
            _process_user_audio(
                websocket,
                stream_sid,
                audio_to_process,
                conversation_history,
                on_speaking=_set_speaking,
            )
        )
        response_task.add_done_callback(_track_response_completion)

    async def _inactivity_watchdog() -> None:
        """Fire end-of-turn after INACTIVITY_END_MS of no new audio.

        Once the timer fires we DETACH ourselves from ``inactivity_task``
        before doing any awaitable work, so a late media frame's
        ``_kick_inactivity_watchdog`` cannot cancel us mid-flush. Cancellation
        of the flush would lose the user's transcript silently — see
        ND-17 follow-up.
        """
        nonlocal inactivity_task
        try:
            await asyncio.sleep(INACTIVITY_END_MS / 1000)
        except asyncio.CancelledError:
            return
        if not speech_started:
            return
        # Detach: from this point on, kicks must spawn a new task rather
        # than cancel us.
        inactivity_task = None
        logger.debug("inactivity watchdog firing end-of-turn")
        await _flush_user_turn()

    def _kick_inactivity_watchdog() -> None:
        """Restart the inactivity timer (called on every media frame after speech started)."""
        nonlocal inactivity_task
        if inactivity_task is not None and not inactivity_task.done():
            inactivity_task.cancel()
        if speech_started:
            inactivity_task = asyncio.create_task(_inactivity_watchdog())

    def _maybe_barge_in() -> None:
        """If the bot is currently TTS-ing and the user just started talking,
        cancel the in-flight response so the bot stops mid-sentence and the
        new turn can be processed once it ends. Called once per turn at the
        first VAD-detected speech frame.

        Gated on ``bot_speaking``: we only cancel during the active TTS-send
        phase. During STT or LLM the bot has not emitted any audio yet, so
        there is nothing for the user to barge in on — cancelling there
        just discards the user's transcribed utterance and leaves the bot
        silent.
        """
        nonlocal response_task
        if response_task is None or response_task.done():
            return
        if not bot_speaking:
            logger.debug(
                "barge-in suppressed: response_task is in STT/LLM phase, not speaking"
            )
            return
        logger.info("barge-in: cancelling in-flight response task")
        response_task.cancel()
        response_task = None

    def _mark_activity() -> None:
        """Reset the idle timer; the next silence period gets one fresh
        re-prompt opportunity."""
        nonlocal last_activity_at, idle_reprompted
        last_activity_at = time.monotonic()
        idle_reprompted = False

    def _track_response_completion(task: asyncio.Task) -> None:
        """Called when a response_task finishes. Restamps ``last_activity_at``
        so the IDLE_REPROMPT_MS window starts from when the bot stopped
        speaking, not from when the task was scheduled. Without this, a slow
        TTS call would eat into the silence window."""
        nonlocal last_activity_at
        last_activity_at = time.monotonic()

    def _maybe_idle_reprompt() -> None:
        """If the caller has been silent past IDLE_REPROMPT_MS since the last
        activity (user speech, bot response start, completed turn), TTS a
        single 'are you still there?' prompt. Re-prompts once per silence
        period — resets when the caller speaks again."""
        nonlocal response_task, idle_reprompted, last_activity_at
        if not greeted or idle_reprompted or speech_started:
            return
        if response_task is not None and not response_task.done():
            return
        if not stream_sid:
            return
        elapsed_ms = (time.monotonic() - last_activity_at) * 1000
        if elapsed_ms < IDLE_REPROMPT_MS:
            return
        logger.info(
            "idle re-prompt: %0.1fs without activity → %r",
            elapsed_ms / 1000,
            IDLE_REPROMPT_TEXT,
        )
        idle_reprompted = True
        last_activity_at = time.monotonic()
        response_task = asyncio.create_task(
            _greet(
                websocket,
                stream_sid,
                IDLE_REPROMPT_TEXT,
                conversation_history,
                on_speaking=_set_speaking,
            )
        )
        response_task.add_done_callback(_track_response_completion)

    def _feed_vad(mulaw_payload: bytes) -> bool:
        """Decode + feed VAD; return True iff end-of-utterance detected."""
        nonlocal speech_started, silence_frames
        pcm = _mulaw8k_chunk_to_pcm16_8k(mulaw_payload)
        pcm16_8k_buf.extend(pcm)
        end_detected = False
        speech_count_in_burst = 0
        non_speech_count_in_burst = 0
        while len(pcm16_8k_buf) >= VAD_BYTES_PER_FRAME_PCM16_8K:
            frame = bytes(pcm16_8k_buf[:VAD_BYTES_PER_FRAME_PCM16_8K])
            del pcm16_8k_buf[:VAD_BYTES_PER_FRAME_PCM16_8K]
            try:
                is_speech = vad.is_speech(frame, 8000)
            except Exception:
                is_speech = False
            if is_speech:
                speech_count_in_burst += 1
                if not speech_started:
                    # First speech frame of this turn — if we're mid-TTS this
                    # is barge-in and we cancel the in-flight response.
                    _maybe_barge_in()
                speech_started = True
                silence_frames = 0
                _mark_activity()
            else:
                non_speech_count_in_burst += 1
                if speech_started:
                    silence_frames += 1
                    if silence_frames >= SILENCE_FRAMES_TO_END:
                        end_detected = True
                        break
        if speech_count_in_burst or non_speech_count_in_burst:
            logger.debug(
                "vad: speech=%d nonspeech=%d started=%s silence=%d end=%s",
                speech_count_in_burst, non_speech_count_in_burst,
                speech_started, silence_frames, end_detected,
            )
        return end_detected

    remote = getattr(websocket, "remote_address", "?")
    logger.info("connection from %s", remote)

    try:
        async for raw_message in websocket:
            if isinstance(raw_message, bytes):
                # Binary frame — treat as raw µ-law payload.
                accumulated_mulaw.extend(raw_message)
                if _feed_vad(raw_message):
                    await _flush_user_turn()
                else:
                    _kick_inactivity_watchdog()
                    _maybe_idle_reprompt()
                continue

            try:
                data = json.loads(raw_message)
            except json.JSONDecodeError:
                logger.debug("non-JSON frame, ignoring")
                continue

            event = data.get("event", "")

            if event == "connected":
                logger.debug("received connected event")
                # Send a greeting immediately so the first agent() step works.
                if not greeted:
                    greeted = True
                    greeting_text = "Hello! Thank you for calling. How can I help you today?"
                    logger.info("sending greeting: %r", greeting_text)
                    response_task = asyncio.create_task(
                        _greet(
                            websocket,
                            stream_sid or "MZ_unknown",
                            greeting_text,
                            conversation_history,
                            on_speaking=_set_speaking,
                        )
                    )
                    response_task.add_done_callback(_track_response_completion)
                    _mark_activity()

            elif event == "start":
                stream_sid = (
                    data.get("streamSid")
                    or (data.get("start") or {}).get("streamSid")
                    or "MZ_unknown"
                )
                call_sid = (data.get("start") or {}).get("callSid") or "CA_unknown"
                logger.info("stream started: stream_sid=%s call_sid=%s", stream_sid, call_sid)
                # If we haven't greeted yet (some clients send start before connected),
                # send greeting now.
                if not greeted:
                    greeted = True
                    greeting_text = "Hello! Thank you for calling. How can I help you today?"
                    logger.info("sending greeting (post-start): %r", greeting_text)
                    response_task = asyncio.create_task(
                        _greet(
                            websocket,
                            stream_sid or "MZ_unknown",
                            greeting_text,
                            conversation_history,
                            on_speaking=_set_speaking,
                        )
                    )
                    response_task.add_done_callback(_track_response_completion)
                    _mark_activity()

            elif event == "media":
                media = data.get("media") or {}
                b64 = media.get("payload", "")
                if b64:
                    try:
                        payload = base64.b64decode(b64)
                        accumulated_mulaw.extend(payload)
                        if _feed_vad(payload):
                            await _flush_user_turn()
                        else:
                            _kick_inactivity_watchdog()
                            _maybe_idle_reprompt()
                    except (ValueError, TypeError):
                        logger.debug("bad base64 in media frame")

            elif event == "mark":
                # Cooperating senders mark the end of an utterance explicitly,
                # so we don't have to guess via VAD timing. ``utterance_end``
                # means: flush whatever we've accumulated as one user turn
                # right now. VAD-based detection stays as fallback for senders
                # that don't emit marks.
                mark = data.get("mark") or {}
                mark_name = mark.get("name", "")
                if mark_name == "utterance_end":
                    logger.debug("received utterance_end mark — flushing")
                    await _flush_user_turn()

            elif event == "clear":
                # Twilio Media Streams ``clear`` — first-class interrupt
                # signal. The controller (PipecatAgentAdapter / scenario
                # interrupt step) has decided to interrupt us; cancel any
                # in-flight TTS immediately. This is the deterministic
                # interrupt path; VAD-based barge-in remains as a fallback
                # for senders that don't emit clear.
                logger.info("received clear event — cancelling in-flight response")
                _maybe_barge_in()

            elif event == "stop":
                logger.info("received stop event — closing")
                break

            elif event == "dtmf":
                dtmf = data.get("dtmf") or {}
                digit = dtmf.get("digit", "")
                logger.info("DTMF digit: %r", digit)
                reply = f"You pressed {digit}. I'll route you there now."
                await _send_tts(
                    websocket,
                    stream_sid or "MZ_unknown",
                    reply,
                    conversation_history,
                    on_speaking=_set_speaking,
                )
                conversation_history.append({"role": "assistant", "content": reply})

    except Exception as exc:
        logger.warning("connection handler error: %s", exc, exc_info=True)
    finally:
        logger.info("connection from %s closed", remote)


async def _greet(
    websocket,
    stream_sid: str,
    text: str,
    history: list[dict],
    on_speaking: Optional[Callable[[bool], None]] = None,
) -> None:
    """TTS-only path used at session start. Wrapped as a task so a fast user
    barge-in (rare, but possible if the user starts speaking before the
    greeting finishes) cancels it cleanly. ``CancelledError`` is suppressed —
    we want barge-in to silently stop the bot, not crash the connection."""
    try:
        await _send_tts(websocket, stream_sid, text, history, on_speaking=on_speaking)
        history.append({"role": "assistant", "content": text})
    except asyncio.CancelledError:
        logger.info("greeting cancelled (barge-in)")
        raise


async def _process_user_audio(
    websocket,
    stream_sid: str,
    mulaw_bytes: bytes,
    history: list[dict],
    on_speaking: Optional[Callable[[bool], None]] = None,
) -> None:
    """STT → LLM → TTS pipeline for one user turn.

    Wrapped as a task by ``_flush_user_turn`` so a barge-in (user starts
    talking again) can cancel it cleanly mid-pipeline."""
    loop = asyncio.get_event_loop()

    try:
        # STT (blocking I/O → run in thread pool).
        transcript = await loop.run_in_executor(None, _openai_stt, mulaw_bytes)
        logger.info("user said: %r", transcript)
        if not transcript:
            logger.debug("empty transcript, skipping response")
            return

        history.append({"role": "user", "content": transcript})

        # LLM.
        reply = await loop.run_in_executor(None, _openai_chat_response, transcript, list(history))
        logger.info("bot reply: %r", reply)
        history.append({"role": "assistant", "content": reply})

        # TTS → send.
        await _send_tts(websocket, stream_sid, reply, history, on_speaking=on_speaking)
    except asyncio.CancelledError:
        logger.info("response cancelled (barge-in) after %d bytes user audio", len(mulaw_bytes))
        raise


async def _send_tts(
    websocket,
    stream_sid: str,
    text: str,
    history: list[dict],
    on_speaking: Optional[Callable[[bool], None]] = None,
) -> None:
    """
    Synthesise ``text`` as speech and stream it back as ``media`` frames.

    Uses OpenAI TTS → PCM16 24 kHz → µ-law 8 kHz → base64 Twilio media frames.

    ``on_speaking`` is invoked with ``True`` immediately before the first
    outbound media frame and ``False`` once the loop exits (including via
    cancellation or peer error). The caller uses it to gate barge-in:
    cancelling the response_task is only legitimate while the bot is
    actively emitting audio.
    """
    loop = asyncio.get_event_loop()
    pcm16_bytes = await loop.run_in_executor(None, _openai_tts_pcm16, text)
    mulaw_bytes = _pcm16_to_mulaw8k(pcm16_bytes)

    if on_speaking is not None:
        on_speaking(True)
    try:
        for frame in _chunk_mulaw(mulaw_bytes):
            if not frame:
                continue
            msg = json.dumps(
                {
                    "event": "media",
                    "streamSid": stream_sid,
                    "media": {"payload": base64.b64encode(frame).decode("ascii")},
                }
            )
            try:
                await websocket.send(msg)
            except Exception as exc:
                logger.warning("send error: %s", exc)
                return
    finally:
        if on_speaking is not None:
            on_speaking(False)


# ---------------------------------------------------------------------------
# Server entry point
# ---------------------------------------------------------------------------


async def serve(host: str = "127.0.0.1", port: int = 8765) -> None:
    """Start the WebSocket server and run until a signal arrives."""
    try:
        import websockets  # hard dep of scenario
    except ImportError:
        logger.error("websockets package not found — install with: pip install websockets>=12")
        raise

    stop = asyncio.get_event_loop().create_future()

    def _handle_signal(signum, frame):  # type: ignore[no-untyped-def]
        logger.info("received signal %s — shutting down", signum)
        if not stop.done():
            stop.set_result(None)

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    async with websockets.serve(
        _handle_connection, host, port, ping_interval=None, ping_timeout=None
    ) as server:
        logger.info(
            "bot listening on ws://%s:%d/stream  (CTRL-C to stop)",
            host,
            port,
        )
        # Log a ready marker that the Makefile poll can grep for.
        print(f"bot: ready on ws://{host}:{port}/stream", flush=True)
        _ = await stop

    logger.info("bot stopped")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Minimal Twilio-Media-Streams stub bot for scenario @e2e voice tests. "
            "Speaks the wire protocol PipecatAgentAdapter expects at /stream."
        )
    )
    parser.add_argument("--host", default=os.environ.get("BOT_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("BOT_PORT", "8765")))
    args = parser.parse_args()

    # Warn early if no OPENAI_API_KEY — the bot will fall back to canned
    # replies rather than crashing, but tests will likely fail at the judge.
    if not os.environ.get("OPENAI_API_KEY"):
        logger.warning(
            "OPENAI_API_KEY is not set — bot will use canned replies and skip TTS/STT. "
            "Most @e2e tests need a real LLM key to pass judge criteria."
        )

    try:
        asyncio.run(serve(host=args.host, port=args.port))
    except KeyboardInterrupt:
        # Ctrl-C is the expected shutdown signal for this CLI; swallow
        # so the user doesn't see an unhandled traceback.
        pass


if __name__ == "__main__":
    main()
