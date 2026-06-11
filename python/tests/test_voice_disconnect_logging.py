"""Tests for _voice_disconnect_all logging (issue #488).

Verifies that disconnect() and ffmpeg-stop failures are logged at WARNING
level with exc_info instead of silently swallowed.
"""

import logging
import pytest
from unittest.mock import MagicMock

from scenario.scenario_executor import ScenarioExecutor
from scenario.voice.adapter import VoiceAgentAdapter
from scenario.voice.audio_chunk import AudioChunk
from scenario.types import AgentInput, AgentReturnTypes


class _FailingVoiceAdapter(VoiceAgentAdapter):
    """Minimal VoiceAgentAdapter that raises on disconnect()."""

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return {"role": "assistant", "content": "ok"}

    async def connect(self) -> None:
        pass

    async def disconnect(self) -> None:
        raise RuntimeError("adapter transport closed unexpectedly")

    async def send_audio(self, chunk: AudioChunk) -> None:
        pass

    async def recv_audio(self, timeout: float) -> AudioChunk:
        raise NotImplementedError


class _OkVoiceAdapter(VoiceAgentAdapter):
    """Minimal VoiceAgentAdapter whose disconnect() succeeds."""

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return {"role": "assistant", "content": "ok"}

    async def connect(self) -> None:
        pass

    async def disconnect(self) -> None:
        pass

    async def send_audio(self, chunk: AudioChunk) -> None:
        pass

    async def recv_audio(self, timeout: float) -> AudioChunk:
        raise NotImplementedError


def _make_executor(*adapters: VoiceAgentAdapter) -> ScenarioExecutor:
    return ScenarioExecutor(
        name="test",
        description="test scenario",
        agents=list(adapters),
    )


@pytest.mark.asyncio
async def test_voice_disconnect_failure_is_logged(caplog: pytest.LogCaptureFixture):
    """A failing disconnect() must emit WARNING with exc_info, not swallow silently."""
    executor = _make_executor(_FailingVoiceAdapter())

    with caplog.at_level(logging.WARNING, logger="scenario"):
        await executor._voice_disconnect_all()

    warning_records = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and "disconnect" in r.message.lower()
    ]
    assert warning_records, (
        "Expected at least one WARNING log record mentioning 'disconnect'; "
        f"got records: {[r.message for r in caplog.records]}"
    )
    # exc_info must be attached so the traceback is visible to operators.
    assert warning_records[0].exc_info is not None, (
        "WARNING record must carry exc_info so the traceback is visible"
    )
    assert "_FailingVoiceAdapter" in warning_records[0].message


@pytest.mark.asyncio
async def test_voice_disconnect_failure_does_not_propagate(caplog: pytest.LogCaptureFixture):
    """A failing disconnect() must not raise — scenario result must be unaffected."""
    executor = _make_executor(_FailingVoiceAdapter())

    with caplog.at_level(logging.WARNING, logger="scenario"):
        # If this raises, the test fails — that's the assertion.
        await executor._voice_disconnect_all()


@pytest.mark.asyncio
async def test_ffmpeg_stop_failure_is_logged(caplog: pytest.LogCaptureFixture):
    """A failing ffmpeg playback.stop() must emit WARNING with exc_info."""
    executor = _make_executor()

    mock_playback = MagicMock()
    mock_playback.stop.side_effect = OSError("ffmpeg process already dead")
    executor._ffmpeg_playback = mock_playback  # type: ignore[assignment]

    with caplog.at_level(logging.WARNING, logger="scenario"):
        await executor._voice_disconnect_all()

    warning_records = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and "ffmpeg" in r.message.lower()
    ]
    assert warning_records, (
        "Expected a WARNING log record mentioning 'ffmpeg'; "
        f"got: {[r.message for r in caplog.records]}"
    )
    assert warning_records[0].exc_info is not None


@pytest.mark.asyncio
async def test_successful_disconnect_produces_no_warnings(caplog: pytest.LogCaptureFixture):
    """A clean disconnect() must not emit any WARNING."""
    executor = _make_executor(_OkVoiceAdapter())

    with caplog.at_level(logging.WARNING, logger="scenario"):
        await executor._voice_disconnect_all()

    warning_records = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert not warning_records, (
        f"Expected no WARNING records on clean disconnect, got: {[r.message for r in warning_records]}"
    )
