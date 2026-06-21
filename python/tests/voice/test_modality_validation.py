"""Tests for two-phase modality validation (AC6, AC7, AC8a, AC8b)."""
from __future__ import annotations

import pytest

from scenario.voice.modality_resolver import (
    ModalityNegotiationError,
    ModalityTier,
    validate_modality_setup,
)
from scenario.voice.capabilities import AdapterCapabilities, UnsupportedCapabilityError
from scenario.voice.adapters._stub import PendingTransportError
from scenario.voice.adapter import VoiceAgentAdapter
from scenario.voice.audio_chunk import AudioChunk


# ---------------------------------------------------------------------------
# Shared test adapters
# ---------------------------------------------------------------------------

class _MulawOnlyAdapter(VoiceAgentAdapter):
    """Simulates a telephony adapter that only supports mulaw/8000."""
    capabilities = AdapterCapabilities(input_formats=["mulaw/8000"])

    async def connect(self) -> None:
        pass

    async def disconnect(self) -> None:
        pass

    async def send_audio(self, chunk) -> None:
        pass

    async def recv_audio(self, timeout):
        return AudioChunk(data=b"")


class _PendingTransportAdapter(VoiceAgentAdapter):
    """Simulates an adapter whose connect() raises PendingTransportError."""
    capabilities = AdapterCapabilities(input_formats=["pcm16/24000"])

    async def connect(self) -> None:
        raise PendingTransportError(type(self).__name__)

    async def disconnect(self) -> None:
        pass

    async def send_audio(self, chunk) -> None:
        pass

    async def recv_audio(self, timeout):
        return AudioChunk(data=b"")


class _NoStreamingAdapter(VoiceAgentAdapter):
    """Adapter without streaming_transcripts capability."""
    capabilities = AdapterCapabilities(streaming_transcripts=False)

    async def connect(self) -> None:
        pass

    async def disconnect(self) -> None:
        pass

    async def send_audio(self, chunk) -> None:
        pass

    async def recv_audio(self, timeout):
        return AudioChunk(data=b"")


class _StreamingAdapter(VoiceAgentAdapter):
    """Adapter with streaming_transcripts and dtmf capability."""
    capabilities = AdapterCapabilities(streaming_transcripts=True, dtmf=True)

    async def connect(self) -> None:
        pass

    async def disconnect(self) -> None:
        pass

    async def send_audio(self, chunk) -> None:
        pass

    async def recv_audio(self, timeout):
        return AudioChunk(data=b"")


# ---------------------------------------------------------------------------
# AC6: Static impossible combo raises at setup
# ---------------------------------------------------------------------------

class TestAC6StaticValidation:
    """AC6: audio-in declared + mulaw-only adapter raises ModalityNegotiationError at setup."""

    def test_audio_in_with_mulaw_only_raises(self):
        with pytest.raises(ModalityNegotiationError) as exc_info:
            validate_modality_setup(
                tier=ModalityTier.AUDIO_IN,
                adapter_input_formats=["mulaw/8000"],
                adapter_name="TelephonyAdapter",
            )
        assert isinstance(exc_info.value, ModalityNegotiationError)

    def test_error_contains_audio_in_modality(self):
        with pytest.raises(ModalityNegotiationError) as exc_info:
            validate_modality_setup(
                tier=ModalityTier.AUDIO_IN,
                adapter_input_formats=["mulaw/8000"],
                adapter_name="TelephonyAdapter",
            )
        assert "audio-in" in str(exc_info.value)

    def test_error_contains_conflicting_format(self):
        with pytest.raises(ModalityNegotiationError) as exc_info:
            validate_modality_setup(
                tier=ModalityTier.AUDIO_IN,
                adapter_input_formats=["mulaw/8000"],
                adapter_name="TelephonyAdapter",
            )
        assert "mulaw/8000" in str(exc_info.value)

    def test_audio_in_with_pcm16_does_not_raise(self):
        # Should succeed without error
        validate_modality_setup(
            tier=ModalityTier.AUDIO_IN,
            adapter_input_formats=["pcm16/24000"],
            adapter_name="OpenAIAdapter",
        )

    def test_audio_in_with_empty_formats_does_not_raise(self):
        # Empty formats = adapter hasn't declared anything; don't block it
        validate_modality_setup(
            tier=ModalityTier.AUDIO_IN,
            adapter_input_formats=[],
            adapter_name="SomeAdapter",
        )

    def test_text_tier_with_mulaw_does_not_raise(self):
        # Text tier doesn't require pcm16; no conflict
        validate_modality_setup(
            tier=ModalityTier.TEXT,
            adapter_input_formats=["mulaw/8000"],
            adapter_name="TelephonyAdapter",
        )

    def test_audio_in_with_mixed_formats_including_pcm16_does_not_raise(self):
        # If any pcm16 path exists, it's compatible
        validate_modality_setup(
            tier=ModalityTier.AUDIO_IN,
            adapter_input_formats=["mulaw/8000", "pcm16/24000"],
            adapter_name="MixedAdapter",
        )


# ---------------------------------------------------------------------------
# AC7: Live-transport failure at first-connect
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ac7_live_transport_failure_raises_before_first_turn():
    """AC7: PendingTransportError caught and re-raised as ModalityNegotiationError."""
    from scenario.scenario_executor import ScenarioExecutor

    adapter = _PendingTransportAdapter()
    executor = ScenarioExecutor(
        name="AC7 test",
        description="test",
        agents=[adapter],
        script=[],
    )

    with pytest.raises(ModalityNegotiationError) as exc_info:
        await executor._voice_connect_all()

    err = exc_info.value
    assert isinstance(err, ModalityNegotiationError)
    # Must carry the requirement token so the user knows what was needed
    assert "audio-in" in str(err)


@pytest.mark.asyncio
async def test_ac7_error_is_modality_negotiation_error_not_pending_transport():
    """AC7: The re-raised exception is ModalityNegotiationError, not PendingTransportError."""
    from scenario.scenario_executor import ScenarioExecutor

    adapter = _PendingTransportAdapter()
    executor = ScenarioExecutor(
        name="AC7 type check",
        description="test",
        agents=[adapter],
        script=[],
    )

    with pytest.raises(Exception) as exc_info:
        await executor._voice_connect_all()

    # Must NOT be a raw PendingTransportError — must be wrapped
    assert type(exc_info.value) is not PendingTransportError
    assert isinstance(exc_info.value, ModalityNegotiationError)


# ---------------------------------------------------------------------------
# AC8a: interrupt(after_words=N) gate fires at connect, not step execution
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ac8a_interrupt_after_words_raises_at_connect_not_step_execution():
    """AC8a: streaming_transcripts gate fires at connect, not mid-run."""
    import scenario
    from scenario.scenario_executor import ScenarioExecutor

    adapter = _NoStreamingAdapter()
    step = scenario.interrupt(content="hello", after_words=3)

    executor = ScenarioExecutor(
        name="AC8a test",
        description="test",
        agents=[adapter],
        script=[step],
    )

    # _voice_connect_all() must raise before any turn executes
    with pytest.raises(UnsupportedCapabilityError) as exc_info:
        await executor._voice_connect_all()

    err = exc_info.value
    assert "streaming_transcripts" in str(err)


@pytest.mark.asyncio
async def test_ac8a_step_is_tagged_with_requires_streaming_transcripts():
    """The interrupt(after_words=N) step function carries the _requires_streaming_transcripts tag."""
    import scenario

    step_without = scenario.interrupt(content="hello")
    step_with = scenario.interrupt(content="hello", after_words=3)

    assert not getattr(step_without, "_requires_streaming_transcripts", False)
    assert getattr(step_with, "_requires_streaming_transcripts", False) is True


@pytest.mark.asyncio
async def test_ac8a_interrupt_without_after_words_does_not_raise_at_connect():
    """AC8a: interrupt without after_words does NOT raise at connect even on non-streaming adapter."""
    import scenario
    from scenario.scenario_executor import ScenarioExecutor

    adapter = _NoStreamingAdapter()
    step = scenario.interrupt(content="hello")  # no after_words

    executor = ScenarioExecutor(
        name="AC8a no-after-words",
        description="test",
        agents=[adapter],
        script=[step],
    )

    # Should NOT raise — no streaming_transcripts requirement without after_words
    await executor._voice_connect_all()
    await executor._voice_disconnect_all()


@pytest.mark.asyncio
async def test_ac8a_interrupt_after_words_with_streaming_adapter_does_not_raise():
    """AC8a: interrupt(after_words=N) on a streaming adapter passes the connect gate."""
    import scenario
    from scenario.scenario_executor import ScenarioExecutor

    adapter = _StreamingAdapter()
    step = scenario.interrupt(content="hello", after_words=3)

    executor = ScenarioExecutor(
        name="AC8a streaming ok",
        description="test",
        agents=[adapter],
        script=[step],
    )

    # Should NOT raise — adapter supports streaming_transcripts
    await executor._voice_connect_all()
    await executor._voice_disconnect_all()


# ---------------------------------------------------------------------------
# AC8b: dtmf gate unchanged (regression)
# ---------------------------------------------------------------------------

class _FakeState:
    """Minimal ScenarioState stand-in for unit-testing script steps."""

    def __init__(self, agents):
        self.agents = agents
        self.messages = []
        self._executor = type("E", (), {"agents": agents})()


@pytest.mark.asyncio
async def test_ac8b_dtmf_gate_unchanged():
    """AC8b: dtmf gate still fires at step execution time (not at connect)."""
    import scenario

    class _NoCapAdapter(VoiceAgentAdapter):
        capabilities = AdapterCapabilities(dtmf=False)

        async def connect(self): pass
        async def disconnect(self): pass
        async def send_audio(self, chunk): pass
        async def recv_audio(self, timeout): return AudioChunk(data=b"")

    adapter = _NoCapAdapter()
    step = scenario.dtmf("1234")

    # dtmf step does NOT have _requires_streaming_transcripts — it must not raise at connect
    assert not getattr(step, "_requires_streaming_transcripts", False)

    # The error fires at step execution time
    state = _FakeState([adapter])
    with pytest.raises(UnsupportedCapabilityError) as exc_info:
        await step(state)  # type: ignore[arg-type,misc]
    assert "dtmf" in str(exc_info.value)
