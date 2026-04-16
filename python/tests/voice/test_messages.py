"""Unit tests for audio message encoding/decoding (audio in any role)."""

from scenario.voice import AudioChunk, create_audio_message, extract_audio, message_has_audio


def _sample_chunk() -> AudioChunk:
    # 100ms of PCM16 silence
    return AudioChunk(data=b"\x00\x00" * 2400, transcript="hello world")


def test_create_audio_message_round_trips_chunk():
    chunk = _sample_chunk()
    msg = create_audio_message(chunk, role="user")

    extracted = extract_audio(msg)
    assert extracted is not None
    assert extracted.data == chunk.data
    assert extracted.transcript == "hello world"


def test_audio_works_cleanly_in_assistant_role():
    # Covers the adaptability requirement: no forceUserRole workaround.
    chunk = _sample_chunk()
    msg = create_audio_message(chunk, role="assistant")
    assert msg["role"] == "assistant"
    assert message_has_audio(msg) is True


def test_message_without_audio_returns_none():
    text_msg = {"role": "user", "content": "just text"}
    assert extract_audio(text_msg) is None  # type: ignore[arg-type]
    assert message_has_audio(text_msg) is False  # type: ignore[arg-type]


def test_transcript_preserved_alongside_audio():
    chunk = AudioChunk(data=b"\x00\x00" * 1200, transcript="foo")
    msg = create_audio_message(chunk)
    text_parts = [p for p in msg["content"] if p.get("type") == "text"]  # type: ignore[union-attr]
    assert text_parts and text_parts[0]["text"] == "foo"  # type: ignore[arg-type,misc,index]
