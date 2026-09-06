"""Per-run STT provider isolation through the public ``scenario.arun`` seam."""

from __future__ import annotations

import asyncio

import pytest

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.judge_agent import JudgeAgent
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult
from scenario.voice import AudioChunk, VoiceConfig, create_audio_message
from scenario.voice.config import resolve_voice_config
from scenario.voice.recording import AudioSegment, VoiceRecording


class _MeetingPoint:
    def __init__(self, parties: int) -> None:
        self._parties = parties
        self._arrived = 0
        self._released = asyncio.Event()

    async def wait(self) -> None:
        self._arrived += 1
        if self._arrived >= self._parties:
            self._released.set()
        await asyncio.wait_for(self._released.wait(), timeout=5)


class _STT:
    def __init__(self, transcript: str, barrier: _MeetingPoint) -> None:
        self.transcript = transcript
        self.barrier = barrier
        self.calls = 0

    async def transcribe(self, audio: AudioChunk) -> str:
        self.calls += 1
        await self.barrier.wait()
        return self.transcript


class _Agent(AgentAdapter):
    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "agent reply"


class _User(AgentAdapter):
    role = AgentRole.USER

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "user request"


class _RecordingJudge(JudgeAgent):
    def __init__(self) -> None:
        super().__init__(criteria=[], model="openai/gpt-4.1-mini", include_audio=False)
        self.transcript: str | None = None

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        recording = VoiceRecording(
            segments=[
                AudioSegment(
                    speaker="agent",
                    start_time=0,
                    end_time=1,
                    audio=b"\x00\x00" * 1200,
                )
            ]
        )
        input.scenario_state._executor._voice_recording = recording
        voice_input = input.model_copy(
            update={
                "messages": [
                    create_audio_message(AudioChunk(data=recording.segments[0].audio))
                ]
            }
        )
        await self._build_conversation_view(voice_input)
        self.transcript = recording.segments[0].transcript
        return ScenarioResult(success=True, messages=[], reasoning="ok")


def test_unset_voice_config_gets_a_fresh_stt_provider():
    """The default is a per-run provider, not a process-wide singleton."""
    assert resolve_voice_config().stt is not resolve_voice_config().stt


@pytest.mark.asyncio
async def test_concurrent_arun_uses_each_runs_stt_provider():
    """The real run boundary carries STT state into each judge independently."""
    barrier = _MeetingPoint(parties=2)

    async def run_one(label: str) -> tuple[_STT, _RecordingJudge]:
        provider = _STT(label, barrier)
        judge = _RecordingJudge()
        result = await scenario.arun(
            name=f"voice-{label}",
            description="concurrent voice provider isolation",
            agents=[_Agent(), _User(), judge],
            script=[scenario.user("hello"), scenario.agent(), scenario.judge()],
            voice=VoiceConfig(stt=provider),
        )
        assert result.success
        return provider, judge

    left, right = await asyncio.gather(run_one("left"), run_one("right"))

    assert left[0].calls == right[0].calls == 1
    assert left[1].transcript == "left"
    assert right[1].transcript == "right"
