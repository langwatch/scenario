"""
Audio message helpers.

Encodes AudioChunks into OpenAI-compatible multimodal messages (input_audio
content parts for user role, assistant messages with a transcript + audio
attachment for assistant role) and extracts them back out.

This is the glue between AudioChunk (internal format) and
ChatCompletionMessageParam (the SDK's existing message bus).
"""

from __future__ import annotations

import base64
from typing import Any, Optional, cast

from openai.types.chat import ChatCompletionMessageParam

from .audio_chunk import AudioChunk, PCM16_SAMPLE_RATE


def _pcm16_to_wav_bytes(pcm: bytes) -> bytes:
    """Wrap raw PCM16 mono bytes at 24kHz in a minimal WAV container."""
    from io import BytesIO
    import wave

    buf = BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(PCM16_SAMPLE_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


def _wav_bytes_to_pcm16(wav: bytes) -> bytes:
    """Extract raw PCM16 frames from a WAV byte string (24kHz mono expected)."""
    from io import BytesIO
    import wave

    with wave.open(BytesIO(wav), "rb") as w:
        return w.readframes(w.getnframes())


def create_audio_message(
    chunk: AudioChunk,
    role: str = "user",
) -> ChatCompletionMessageParam:
    """
    Turn an AudioChunk into an OpenAI-compatible message.

    The content is a list with an input_audio part carrying base64-encoded WAV.
    If the chunk has a transcript, it is added as a text part alongside the
    audio — this is what lets the judge's text-only path still read the content.

    Audio travels cleanly in any role (user or assistant) per the locked design
    — there is no forceUserRole workaround.
    """
    wav = _pcm16_to_wav_bytes(chunk.data)
    b64 = base64.b64encode(wav).decode()
    parts: list[dict[str, Any]] = [
        {
            "type": "input_audio",
            "input_audio": {"data": b64, "format": "wav"},
        }
    ]
    if chunk.transcript:
        parts.insert(0, {"type": "text", "text": chunk.transcript})
    return cast(ChatCompletionMessageParam, {"role": role, "content": parts})


def extract_audio(message: ChatCompletionMessageParam) -> Optional[AudioChunk]:
    """
    Pull the first audio chunk out of an OpenAI-format message.

    Returns None if the message has no audio content part. Accepts both
    'input_audio' (OpenAI API convention) and 'audio' (alternate providers).
    """
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        return None

    transcript: Optional[str] = None
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text":
            transcript = part.get("text") or transcript
        if part.get("type") in ("input_audio", "audio"):
            data_obj = part.get("input_audio") or part.get("audio") or {}
            b64 = data_obj.get("data") if isinstance(data_obj, dict) else None
            if not b64:
                continue
            raw = base64.b64decode(b64)
            # We expect WAV by convention. If it's raw PCM, bytes pass through.
            if raw[:4] == b"RIFF":
                pcm = _wav_bytes_to_pcm16(raw)
            else:
                pcm = raw
            return AudioChunk(data=pcm, transcript=transcript)
    return None


def message_has_audio(message: ChatCompletionMessageParam) -> bool:
    """True if the message contains any audio content part."""
    return extract_audio(message) is not None
