"""Judge pre-pass STT span coverage for issue #785."""

from __future__ import annotations

import logging

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import StatusCode
from opentelemetry.util._once import Once

from scenario.voice._transcribe import transcribe_segments
from scenario.voice.recording import AudioSegment, SpeakerRole, VoiceRecording
from scenario.voice.stt import STTProvider

from ._span_assert import attrs


@pytest.fixture(autouse=True)
def reset_otel():
    """Reset the global provider around each telemetry test."""

    def _reset() -> None:
        trace._TRACER_PROVIDER = None
        trace._TRACER_PROVIDER_SET_ONCE = Once()

    _reset()
    yield
    _reset()


def _install_exporter() -> InMemorySpanExporter:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    return exporter


def _segment(speaker: SpeakerRole, marker: int) -> AudioSegment:
    return AudioSegment(
        speaker=speaker,
        start_time=float(marker),
        end_time=float(marker + 1),
        audio=bytes([marker, 0]) * 100,
        transcript=None,
    )


def _recorded_exception_text(span) -> str:
    values: list[str] = []
    for event in span.events:
        for key in ("exception.type", "exception.message", "exception.stacktrace"):
            value = (event.attributes or {}).get(key)
            if value:
                values.append(str(value))
    return " ".join(values)


@pytest.mark.asyncio
async def test_judge_stt_emits_scoped_span_with_success_attributes():
    exporter = _install_exporter()

    class _STT(STTProvider):
        async def transcribe(self, _audio):
            return "account restored"

    recording = VoiceRecording(segments=[_segment("agent", 1)])
    await transcribe_segments(recording, provider=_STT())

    spans = [
        s for s in exporter.get_finished_spans() if s.name == "voice.stt.transcribe"
    ]
    assert len(spans) == 1
    attributes = attrs(spans[0])
    assert attributes["voice.stt.scope"] == "judge"
    assert attributes["voice.stt.speaker"] == "agent"
    assert attributes["voice.stt.audio_bytes"] == 200
    assert attributes["voice.stt.transcript_chars"] == len("account restored")
    assert attributes["langwatch.span.type"] == "span"
    assert recording.segments[0].transcript == "account restored"


@pytest.mark.asyncio
async def test_judge_stt_mixed_batch_isolates_failure_and_sanitizes_span(caplog):
    exporter = _install_exporter()
    raw_error = "401 invalid key sk-secret body={provider response}"

    class _MixedSTT(STTProvider):
        async def transcribe(self, audio):
            if audio.data[0] == 1:
                raise RuntimeError(raw_error)
            return "successful sibling"

    recording = VoiceRecording(segments=[_segment("user", 1), _segment("agent", 2)])
    with caplog.at_level(logging.WARNING, logger="scenario.voice"):
        await transcribe_segments(recording, provider=_MixedSTT())

    assert [segment.transcript for segment in recording.segments] == [
        None,
        "successful sibling",
    ]
    spans = [
        s for s in exporter.get_finished_spans() if s.name == "voice.stt.transcribe"
    ]
    assert len(spans) == 2
    failed = next(s for s in spans if s.status.status_code == StatusCode.ERROR)
    succeeded = next(s for s in spans if s.status.status_code != StatusCode.ERROR)
    failed_attributes = attrs(failed)
    succeeded_attributes = attrs(succeeded)
    assert failed_attributes["voice.stt.scope"] == "judge"
    assert failed_attributes["voice.stt.speaker"] == "user"
    assert "voice.stt.transcript_chars" not in failed_attributes
    assert succeeded_attributes["voice.stt.transcript_chars"] == len(
        "successful sibling"
    )
    recorded = _recorded_exception_text(failed)
    assert "STT provider failed" in recorded
    assert "sk-secret" not in recorded
    assert "401" not in recorded
    assert "provider response" not in recorded
    assert raw_error not in caplog.text
    assert "STT provider failed: RuntimeError" in caplog.text
