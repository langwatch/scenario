"""Per-run STT provider isolation through the public ``scenario.arun`` seam."""

from __future__ import annotations

import asyncio

import pytest

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.judge_agent import JudgeAgent
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult
from scenario.voice import (
    AudioChunk,
    VoiceConfig,
    VoiceAgentAdapter,
    create_audio_message,
    get_stt_provider,
    set_stt_provider,
)
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


def test_unset_voice_config_gets_a_fresh_stt_provider() -> None:
    """The default is a per-run provider, not a process-wide singleton."""
    assert resolve_voice_config().stt is not resolve_voice_config().stt


@pytest.mark.asyncio
async def test_concurrent_arun_uses_each_runs_stt_provider() -> None:
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


@pytest.mark.asyncio
async def test_arun_without_voice_snapshots_the_legacy_stt_provider() -> None:
    """Legacy configuration is sampled at the run boundary, not by the judge."""
    previous = get_stt_provider()
    provider = _STT("legacy", _MeetingPoint(parties=1))
    replacement = _STT("replacement", _MeetingPoint(parties=1))
    started = asyncio.Event()
    release = asyncio.Event()

    class _PausingAgent(_Agent):
        async def call(self, input: AgentInput) -> AgentReturnTypes:
            started.set()
            await release.wait()
            return "agent reply"

    set_stt_provider(provider)
    judge = _RecordingJudge()
    try:
        run = asyncio.create_task(
            scenario.arun(
                name="legacy-voice",
                description="legacy voice provider compatibility",
                agents=[_PausingAgent(), _User(), judge],
                script=[scenario.user("hello"), scenario.agent(), scenario.judge()],
            )
        )
        await started.wait()
        set_stt_provider(replacement)
        release.set()
        result = await run
    finally:
        set_stt_provider(previous)

    assert result.success
    assert provider.calls == 1
    assert replacement.calls == 0
    assert judge.transcript == "legacy"


@pytest.mark.asyncio
async def test_audio_only_adapter_transcribes_with_the_runs_provider() -> None:
    """Per-turn adapter STT resolves the run's provider, never the global default.

    A successful global-provider transcript would also make the judge's
    ``only_missing`` backfill skip the segment, so the run's provider would
    never see the audio at all.
    """
    previous = get_stt_provider()
    run_provider = _STT("run", _MeetingPoint(parties=1))
    forbidden = _STT("global", _MeetingPoint(parties=1))
    set_stt_provider(forbidden)

    class _AudioOnlyAgent(VoiceAgentAdapter):
        """Uses the base ``call()``: drains recv_audio, transcribes per turn."""

        def __init__(self) -> None:
            super().__init__()
            self.response_tail_silence = 0.05
            self._served = False

        async def connect(self) -> None:
            pass

        async def disconnect(self) -> None:
            pass

        async def send_audio(self, chunk: AudioChunk) -> None:
            pass

        async def recv_audio(self, timeout: float) -> AudioChunk:
            if not self._served:
                self._served = True
                return AudioChunk(data=b"\x00\x01" * 1200)
            return AudioChunk(data=b"")

    class _OkJudge(JudgeAgent):
        def __init__(self) -> None:
            super().__init__(
                criteria=[], model="openai/gpt-4.1-mini", include_audio=False
            )

        async def call(self, input: AgentInput) -> AgentReturnTypes:
            return ScenarioResult(success=True, messages=[], reasoning="ok")

    try:
        result = await scenario.arun(
            name="voice-adapter-per-turn-stt",
            description="adapter per-turn STT resolves the run provider",
            agents=[_AudioOnlyAgent(), _User(), _OkJudge()],
            script=[scenario.user("hello"), scenario.agent(), scenario.judge()],
            voice=VoiceConfig(stt=run_provider),
        )
        assert result.success
        assert run_provider.calls >= 1
        assert forbidden.calls == 0
    finally:
        set_stt_provider(previous)
