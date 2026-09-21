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
    STTProvider,
    VoiceConfig,
    VoiceAgentAdapter,
    create_audio_message,
    set_stt_provider,
)
from scenario.voice.config import SttConfig, TtsConfig, resolve_voice_config
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


class _STT(STTProvider):
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
    import scenario.voice.stt as stt_module

    previous = stt_module._legacy_provider
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
        stt_module._legacy_provider = previous

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
    import scenario.voice.stt as stt_module

    previous = stt_module._legacy_provider
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

    try:
        result = await scenario.arun(
            name="voice-adapter-per-turn-stt",
            description="adapter per-turn STT resolves the run provider",
            agents=[_AudioOnlyAgent(), _User()],
            script=[
                scenario.user("hello"),
                scenario.agent(),
                scenario.succeed("adapter turn transcribed"),
            ],
            voice=VoiceConfig(stt=run_provider),
        )
        assert result.success
        assert run_provider.calls >= 1
        assert forbidden.calls == 0
    finally:
        stt_module._legacy_provider = previous


def test_unsupported_voice_value_is_rejected() -> None:
    """A voice= typo fails loudly instead of silently using a fresh default."""
    with pytest.raises(TypeError, match="voice expects a VoiceConfig"):
        resolve_voice_config(
            scenario_level="openai/whisper-1"  # type: ignore[arg-type]  # the rejected string is the case under test
        )


def test_unset_runs_mint_their_own_default_provider() -> None:
    """Without a registered legacy provider, each read mints a fresh default."""
    import scenario.voice.stt as stt_module
    from scenario.voice.stt import OpenAISTTProvider

    previous = stt_module._legacy_provider
    stt_module._legacy_provider = None
    try:
        first = stt_module.get_stt_provider()
        second = stt_module.get_stt_provider()
        assert isinstance(first, OpenAISTTProvider)
        assert first is not second
    finally:
        stt_module._legacy_provider = previous


def test_falsey_explicit_provider_is_not_replaced() -> None:
    """A provider whose __bool__ is False is still the configured provider."""

    class _Falsey(_STT):
        def __bool__(self) -> bool:
            return False

    provider = _Falsey("falsey", _MeetingPoint(parties=1))
    resolved = resolve_voice_config(scenario_level=VoiceConfig(stt=provider))
    assert resolved.stt is provider


@pytest.mark.asyncio
async def test_shared_voice_config_is_not_stamped_across_runs() -> None:
    """A VoiceConfig reused across runs is copied, never written into."""
    shared = VoiceConfig()

    async def one_run() -> None:
        await scenario.arun(
            name="shared-voice-carrier",
            description="executor copies the caller carrier",
            agents=[_Agent(), _User()],
            script=[scenario.user("hello"), scenario.succeed("done")],
            voice=shared,
        )

    await one_run()
    assert shared.stt is None
    await one_run()
    assert shared.stt is None


def test_mapping_stt_descriptor_holds_no_credential_after_dump() -> None:
    """Mapping descriptors normalize to SttConfig, whose key never serializes."""
    carrier = VoiceConfig(stt={"model": "openai/whisper-1", "api_key": "sk-secret"})
    assert isinstance(carrier.stt, SttConfig)
    assert "sk-secret" not in str(carrier.model_dump())


@pytest.mark.parametrize("as_mapping", [False, True], ids=["typed", "mapping"])
def test_snapshot_copies_nested_descriptors_not_providers(as_mapping: bool) -> None:
    """Descriptor values are snapshotted in both carrier forms; providers shared."""
    stt = SttConfig(model="openai/whisper-1", api_key="a")
    tts = TtsConfig(voice="openai/alloy", api_key="b")
    carrier = (
        VoiceConfig.model_validate({"stt": stt, "tts": tts})
        if as_mapping
        else VoiceConfig(stt=stt, tts=tts)
    )

    snap = carrier.snapshot()
    assert snap.stt is not None
    assert snap.tts is not None
    assert snap.stt is not stt
    assert snap.tts is not tts
    stt.api_key = "changed"
    assert snap.stt.api_key == "a"

    provider = _STT("shared", _MeetingPoint(parties=1))
    assert VoiceConfig(stt=provider).snapshot().stt is provider
