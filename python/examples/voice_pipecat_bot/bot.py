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

The bot uses OpenAI's chat API (gpt-4o-mini) to generate text responses, then
synthesises speech via OpenAI TTS (tts-1 / alloy voice) and converts the
resulting MP3 to µ-law 8 kHz for the wire.

Running the bot
---------------

    cd python
    uv run python examples/voice_pipecat_bot/bot.py

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
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Bootstrap: load .env so OPENAI_API_KEY is available when run from python/
# ---------------------------------------------------------------------------

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")
except ImportError:
    pass  # dotenv is a scenario dep; if missing, env must already be set


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
            model="gpt-4o-mini",
            messages=messages,  # type: ignore[arg-type]
            max_tokens=60,
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
            model="tts-1",
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
                    model="whisper-1",
                    file=fh,
                )
            return result.text.strip()
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
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
    """Handle one WS connection from a PipecatAgentAdapter client."""
    import websockets.exceptions  # noqa: F401  — imported for isinstance check below

    stream_sid: Optional[str] = None
    call_sid: Optional[str] = None
    accumulated_mulaw = bytearray()
    conversation_history: list[dict] = []
    # How many µ-law bytes = 1 s of audio (8000 bytes/s for 8 kHz mono µ-law).
    SILENCE_THRESHOLD_BYTES = 8000  # gather ~1 s before responding
    greeted = False

    remote = getattr(websocket, "remote_address", "?")
    logger.info("connection from %s", remote)

    try:
        async for raw_message in websocket:
            if isinstance(raw_message, bytes):
                # Binary frame — treat as raw µ-law payload.
                accumulated_mulaw.extend(raw_message)
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
                    await _send_tts(websocket, stream_sid or "MZ_unknown", greeting_text, conversation_history)
                    conversation_history.append({"role": "assistant", "content": greeting_text})

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
                    await _send_tts(websocket, stream_sid or "MZ_unknown", greeting_text, conversation_history)
                    conversation_history.append({"role": "assistant", "content": greeting_text})

            elif event == "media":
                media = data.get("media") or {}
                b64 = media.get("payload", "")
                if b64:
                    try:
                        payload = base64.b64decode(b64)
                        accumulated_mulaw.extend(payload)
                    except (ValueError, TypeError):
                        logger.debug("bad base64 in media frame")

                    # Once we have enough audio, transcribe + respond.
                    if stream_sid and len(accumulated_mulaw) >= SILENCE_THRESHOLD_BYTES:
                        audio_to_process = bytes(accumulated_mulaw)
                        accumulated_mulaw.clear()
                        await _process_user_audio(
                            websocket,
                            stream_sid,
                            audio_to_process,
                            conversation_history,
                        )

            elif event == "stop":
                logger.info("received stop event — closing")
                break

            elif event == "dtmf":
                dtmf = data.get("dtmf") or {}
                digit = dtmf.get("digit", "")
                logger.info("DTMF digit: %r", digit)
                reply = f"You pressed {digit}. I'll route you there now."
                await _send_tts(websocket, stream_sid or "MZ_unknown", reply, conversation_history)
                conversation_history.append({"role": "assistant", "content": reply})

    except Exception as exc:
        logger.warning("connection handler error: %s", exc, exc_info=True)
    finally:
        logger.info("connection from %s closed", remote)


async def _process_user_audio(
    websocket,
    stream_sid: str,
    mulaw_bytes: bytes,
    history: list[dict],
) -> None:
    """STT → LLM → TTS pipeline for one user turn."""
    loop = asyncio.get_event_loop()

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
    await _send_tts(websocket, stream_sid, reply, history)


async def _send_tts(
    websocket,
    stream_sid: str,
    text: str,
    history: list[dict],
) -> None:
    """
    Synthesise ``text`` as speech and stream it back as ``media`` frames.

    Uses OpenAI TTS → PCM16 24 kHz → µ-law 8 kHz → base64 Twilio media frames.
    """
    loop = asyncio.get_event_loop()
    pcm16_bytes = await loop.run_in_executor(None, _openai_tts_pcm16, text)
    mulaw_bytes = _pcm16_to_mulaw8k(pcm16_bytes)

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

    async with websockets.serve(_handle_connection, host, port) as server:
        logger.info(
            "bot listening on ws://%s:%d/stream  (CTRL-C to stop)",
            host,
            port,
        )
        # Log a ready marker that the Makefile poll can grep for.
        print(f"bot: ready on ws://{host}:{port}/stream", flush=True)
        await stop

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
        pass


if __name__ == "__main__":
    main()
