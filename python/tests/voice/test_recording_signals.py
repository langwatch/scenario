"""
Unit tests verifying the default VoiceAgentAdapter.call() emits segments,
timeline events, and latency measurements — so result.audio / result.timeline /
result.latency get populated (the gap reviewers flagged: recording.segments
was never populated).
"""

import pytest

import scenario
from scenario.voice import (
    AdapterCapabilities,
    AudioChunk,
    VoiceAgentAdapter,
)


class _AudioEchoAdapter(VoiceAgentAdapter):
    """Accepts audio, immediately responds with a canned chunk."""

    capabilities = AdapterCapabilities()

    def __init__(self):
        super().__init__()
        self._incoming: AudioChunk | None = None
        self.response = AudioChunk(
            data=b"\x00\x01" * 2400, transcript="response text"
        )

    async def connect(self):
        pass
    async def disconnect(self):
        pass
    async def send_audio(self, chunk: AudioChunk) -> None:
        self._incoming = chunk

    async def recv_audio(self, timeout: float) -> AudioChunk:
        return self.response


class _TextUser(scenario.AgentAdapter):
    role = scenario.AgentRole.USER

    async def call(self, input):
        from scenario.voice import AudioChunk, create_audio_message

        chunk = AudioChunk(data=b"\x00\x02" * 2400, transcript="user text")
        return create_audio_message(chunk, role="user")


@pytest.mark.asyncio
async def test_voice_adapter_call_records_segments_and_timeline():
    adapter = _AudioEchoAdapter()
    user = _TextUser()
    result = await scenario.run(
        name="records segments",
        description="voice adapter default call() populates result.audio",
        agents=[adapter, user],
        script=[scenario.user(), scenario.agent(), scenario.succeed("done")],
    )
    assert result.audio is not None, "result.audio must be populated when voice adapter ran"
    assert len(result.audio.segments) >= 2, "expected user + agent segments"
    speakers = {s.speaker for s in result.audio.segments}
    assert speakers == {"user", "agent"}

    # Timeline must contain start/stop events for both speakers.
    assert result.timeline is not None
    types = {e.type for e in result.timeline}
    assert {"user_start_speaking", "user_stop_speaking",
            "agent_start_speaking", "agent_stop_speaking"} <= types

    # Latency must be recorded (agent started after user stopped).
    assert result.latency is not None
    assert result.latency.time_to_first_byte is not None
    assert len(result.latency.measurements) >= 1
