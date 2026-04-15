"""Unit tests for AdapterCapabilities and UnsupportedCapabilityError."""

import pytest

from scenario.voice import AdapterCapabilities, UnsupportedCapabilityError


def test_default_capabilities_are_conservative():
    # New adapters default to "no capabilities" — safer to opt-in.
    caps = AdapterCapabilities()
    assert caps.streaming_transcripts is False
    assert caps.native_vad is False
    assert caps.dtmf is False
    assert caps.input_formats == []
    assert caps.output_formats == []


def test_capabilities_are_frozen():
    caps = AdapterCapabilities(native_vad=True)
    with pytest.raises(Exception):
        caps.native_vad = False  # type: ignore[misc]


def test_error_names_adapter_and_capability():
    err = UnsupportedCapabilityError("PipecatAgent", "dtmf", hint="Try TwilioAgent.")
    message = str(err)
    assert "PipecatAgent" in message
    assert "dtmf" in message
    assert "TwilioAgent" in message
    assert err.adapter_name == "PipecatAgent"
    assert err.capability == "dtmf"


def test_error_message_points_to_capability_matrix_docs():
    err = UnsupportedCapabilityError("X", "streaming_transcripts")
    assert "capability matrix" in str(err).lower()
