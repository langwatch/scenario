"""Unit tests for scenario.voice._transcribe."""
from __future__ import annotations

import logging
import pytest
from unittest.mock import AsyncMock

from scenario.voice.recording import AudioSegment, VoiceRecording
from scenario.voice._transcribe import transcribe_segments


# ------------------------------------------------------------------ helpers


def _rec(n_segments: int = 2) -> VoiceRecording:
    """Build a VoiceRecording with N agent segments, all transcript=None."""
    return VoiceRecording(
        segments=[
            AudioSegment(
                speaker="agent",
                start_time=float(i),
                end_time=float(i + 1),
                audio=b"\x00\x00" * 100,
                transcript=None,
            )
            for i in range(n_segments)
        ]
    )


class _FakeSTT:
    """Minimal in-memory STT stub."""

    def __init__(self, text: str = "hello world") -> None:
        self._text = text
        self.calls: int = 0

    async def transcribe(self, audio):
        self.calls += 1
        return self._text


# ------------------------------------------------------------------ tests


@pytest.mark.asyncio
async def test_transcribe_segments_fills_missing(monkeypatch):
    """A fake provider fills all transcript=None segments."""
    fake = _FakeSTT("hello world")
    monkeypatch.setattr(
        "scenario.voice._transcribe.get_stt_provider",
        lambda: fake,
    )

    rec = _rec(2)
    await transcribe_segments(rec)

    assert rec.segments[0].transcript == "hello world"
    assert rec.segments[1].transcript == "hello world"
    assert fake.calls == 2


@pytest.mark.asyncio
async def test_transcribe_segments_skips_already_set(monkeypatch):
    """Segments with an existing transcript are not re-transcribed with only_missing=True."""
    fake = _FakeSTT("new text")
    monkeypatch.setattr(
        "scenario.voice._transcribe.get_stt_provider",
        lambda: fake,
    )

    rec = _rec(2)
    rec.segments[0].transcript = "preset"  # pre-populated

    await transcribe_segments(rec, only_missing=True)

    # preset segment is untouched
    assert rec.segments[0].transcript == "preset"
    # second segment gets filled
    assert rec.segments[1].transcript == "new text"
    # STT called only once (for the missing one)
    assert fake.calls == 1


@pytest.mark.asyncio
async def test_transcribe_segments_skips_empty_audio(monkeypatch):
    """Segments with empty audio bytes are skipped; STT is never called."""
    mock_transcribe = AsyncMock(return_value="text")

    class _FakeSTTMock:
        transcribe = mock_transcribe

    monkeypatch.setattr(
        "scenario.voice._transcribe.get_stt_provider",
        lambda: _FakeSTTMock(),
    )

    rec = VoiceRecording(
        segments=[
            AudioSegment(
                speaker="agent",
                start_time=0.0,
                end_time=1.0,
                audio=b"",  # empty
                transcript=None,
            )
        ]
    )

    await transcribe_segments(rec)

    mock_transcribe.assert_not_called()
    assert rec.segments[0].transcript is None


@pytest.mark.asyncio
async def test_transcribe_segments_warns_on_missing_provider(caplog, monkeypatch):
    """When get_stt_provider() raises, a warning is logged and no exception bubbles."""

    def _raise():
        raise RuntimeError("no provider")

    monkeypatch.setattr("scenario.voice._transcribe.get_stt_provider", _raise)

    rec = _rec(1)

    with caplog.at_level(logging.WARNING, logger="scenario.voice"):
        await transcribe_segments(rec)  # must not raise

    assert "no STT provider" in caplog.text or "no provider" in caplog.text
    # Transcripts remain None
    assert rec.segments[0].transcript is None


@pytest.mark.asyncio
async def test_transcribe_segments_per_segment_failure_isolated(caplog, monkeypatch):
    """A per-segment STT failure doesn't prevent other segments from being filled."""
    call_count = 0

    class _FailFirstSTT:
        async def transcribe(self, audio):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("STT boom")
            return "ok text"

    monkeypatch.setattr(
        "scenario.voice._transcribe.get_stt_provider",
        lambda: _FailFirstSTT(),
    )

    rec = _rec(2)

    with caplog.at_level(logging.WARNING, logger="scenario.voice"):
        await transcribe_segments(rec)

    transcripts = [s.transcript for s in rec.segments]
    # One segment failed (transcript stays None), one succeeded (transcript filled).
    assert transcripts.count(None) == 1
    assert transcripts.count("ok text") == 1

    # Warning logged once for the failure
    assert "STT failed" in caplog.text


@pytest.mark.asyncio
async def test_transcribe_segments_empty_recording_is_noop():
    """VoiceRecording with no segments completes without error."""
    rec = VoiceRecording(segments=[])
    await transcribe_segments(rec)  # must not raise
