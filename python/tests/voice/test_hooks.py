"""
Unit tests for on_audio_chunk / on_voice_event hooks on scenario.run (§4.7).
"""

import pytest

import scenario
from scenario.voice import (
    AdapterCapabilities,
    AudioChunk,
    VoiceAgentAdapter,
    VoiceEvent,
)


class _EchoVoiceAdapter(VoiceAgentAdapter):
    capabilities = AdapterCapabilities()

    async def connect(self): ...
    async def disconnect(self): ...
    async def send_audio(self, chunk): ...

    async def recv_audio(self, timeout):
        return AudioChunk(data=b"\x00\x01" * 2400, transcript="echo")


class _CannedUser(scenario.AgentAdapter):
    role = scenario.AgentRole.USER

    async def call(self, input):
        from scenario.voice import AudioChunk, create_audio_message

        return create_audio_message(
            AudioChunk(data=b"\x00\x02" * 2400, transcript="hi"), role="user"
        )


@pytest.mark.asyncio
async def test_on_audio_chunk_fires_for_both_speakers():
    chunks: list[AudioChunk] = []
    result = await scenario.run(
        name="on_audio_chunk",
        description="hook fires for user + agent audio",
        agents=[_EchoVoiceAdapter(), _CannedUser()],
        script=[scenario.user(), scenario.agent(), scenario.succeed("done")],
        on_audio_chunk=chunks.append,
    )
    assert result.success
    assert len(chunks) >= 2
    assert all(isinstance(c, AudioChunk) for c in chunks)


@pytest.mark.asyncio
async def test_on_voice_event_fires_for_timeline_events():
    events: list[VoiceEvent] = []
    await scenario.run(
        name="on_voice_event",
        description="hook fires for timeline events",
        agents=[_EchoVoiceAdapter(), _CannedUser()],
        script=[scenario.user(), scenario.agent(), scenario.succeed("done")],
        on_voice_event=events.append,
    )
    types = {e.type for e in events}
    assert "user_start_speaking" in types
    assert "agent_start_speaking" in types


@pytest.mark.asyncio
async def test_hook_errors_do_not_abort_scenario():
    def _boom(_):
        raise RuntimeError("callback failure")

    result = await scenario.run(
        name="hook errors",
        description="callback errors are swallowed",
        agents=[_EchoVoiceAdapter(), _CannedUser()],
        script=[scenario.user(), scenario.agent(), scenario.succeed("done")],
        on_audio_chunk=_boom,
        on_voice_event=_boom,
    )
    # Scenario still succeeds even though every hook invocation raised.
    assert result.success
