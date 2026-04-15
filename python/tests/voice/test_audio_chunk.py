"""Unit tests for AudioChunk (Locked decision: AudioChunk normalization)."""

from scenario.voice import AudioChunk, silent_chunk


def test_audio_chunk_defaults_to_pcm16_24khz_mono():
    # The canonical internal format is fixed (Locked decision: PCM16 @ 24kHz mono).
    chunk = AudioChunk(data=b"\x00\x00" * 240)
    assert chunk.sample_rate == 24000
    assert chunk.channels == 1


def test_audio_chunk_duration_from_pcm16_bytes():
    # 24000 samples * 2 bytes = 1 second of audio.
    chunk = AudioChunk(data=b"\x00\x00" * 24000)
    assert abs(chunk.duration_seconds - 1.0) < 1e-6


def test_empty_chunk_has_zero_duration():
    assert AudioChunk(data=b"").duration_seconds == 0.0


def test_silent_chunk_matches_requested_duration():
    chunk = silent_chunk(0.5)
    assert abs(chunk.duration_seconds - 0.5) < 1e-6
    # PCM16 silence is literally zeros.
    assert set(chunk.data) == {0}
