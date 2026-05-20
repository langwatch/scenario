"""Unit tests for AdapterCapabilities and UnsupportedCapabilityError."""

import pytest

from scenario.voice import AdapterCapabilities, UnsupportedCapabilityError


def test_default_capabilities_are_conservative():
    # New adapters default to "no capabilities" — safer to opt-in.
    caps = AdapterCapabilities()
    assert caps.streaming_transcripts is False
    assert caps.native_vad is False
    assert caps.dtmf is False
    assert caps.interruption is False
    assert caps.input_formats == []
    assert caps.output_formats == []


def test_capabilities_are_immutable_after_construction():
    # AdapterCapabilities is frozen so adapters can't accidentally mutate the
    # shared class-level ClassVar default. Attempting assignment must raise
    # FrozenInstanceError specifically (not some unrelated error).
    from dataclasses import FrozenInstanceError

    caps = AdapterCapabilities(native_vad=True)
    with pytest.raises(FrozenInstanceError):
        caps.native_vad = False  # type: ignore[misc]


def test_error_names_adapter_and_capability():
    err = UnsupportedCapabilityError("PipecatAgentAdapter", "dtmf", hint="Try TwilioAgentAdapter.")
    message = str(err)
    assert "PipecatAgentAdapter" in message
    assert "dtmf" in message
    assert "TwilioAgentAdapter" in message
    assert err.adapter_name == "PipecatAgentAdapter"
    assert err.capability == "dtmf"


def test_error_message_points_to_capability_matrix_docs():
    err = UnsupportedCapabilityError("X", "streaming_transcripts")
    assert "capability matrix" in str(err).lower()


@pytest.mark.asyncio
async def test_interrupt_raises_unsupported_when_interruption_false():
    """An adapter that does not declare ``interruption=True`` must reject
    ``await adapter.interrupt()`` with ``UnsupportedCapabilityError`` —
    the contract that lets ``scenario.interrupt()`` fall back to
    timing-based barge-in instead of silently no-op'ing.
    """
    from scenario.voice.adapter import VoiceAgentAdapter

    class BareVoiceAdapter(VoiceAgentAdapter):
        # Inherits the default AdapterCapabilities() → interruption=False.
        async def connect(self) -> None:
            pass
        async def disconnect(self) -> None:
            pass
        async def send_audio(self, chunk) -> None:  # type: ignore[override]
            pass
        async def recv_audio(self, timeout):  # type: ignore[override]
            raise NotImplementedError

    adapter = BareVoiceAdapter()
    assert adapter.capabilities.interruption is False
    with pytest.raises(UnsupportedCapabilityError) as exc_info:
        await adapter.interrupt()
    assert exc_info.value.capability == "interruption"
    assert exc_info.value.adapter_name == "BareVoiceAdapter"
