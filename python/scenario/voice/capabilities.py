"""
Adapter capability matrix.

Planning-level addition (not in the source proposal). Exists to support the
after_words UnsupportedCapabilityError locked decision — you cannot raise on
an "unsupported capability" without first defining which capabilities exist.

Every VoiceAgentAdapter publishes an AdapterCapabilities instance as
``adapter.capabilities``. Capability-gated script steps check it and raise
UnsupportedCapabilityError when the underlying adapter cannot implement the
requested behavior (e.g., interrupt(after_words=N) needs streaming transcripts;
dtmf() needs telephony; etc.).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List


@dataclass(frozen=True)
class AdapterCapabilities:
    """
    Declaration of what a voice adapter can and cannot do.

    Attributes:
        streaming_transcripts: True if the adapter emits incremental transcript
            updates as the agent speaks. Required for interrupt(after_words=N).
        native_vad: True if the adapter itself provides voice-activity-detection
            events (user_start_speaking / user_stop_speaking). When False, the
            SDK falls back to webrtcvad on the incoming audio stream.
        dtmf: True if the adapter can transmit DTMF tones (telephony).
        interruption: True if the adapter can send a first-class interrupt
            signal to the agent under test (e.g., Twilio ``clear``, OpenAI
            Realtime ``response.cancel``). When True, ``scenario.interrupt()``
            uses the signal path; when False, it falls back to timing-based
            barge-in (audio sent over the wire while the agent is speaking,
            which the SUT detects via VAD).
        input_formats: Wire formats the adapter can accept from the SDK for
            outgoing user audio (e.g., ["pcm16/24000", "mulaw/8000"]).
        output_formats: Wire formats the adapter emits for incoming agent
            audio. The SDK converts these to internal PCM16/24000 mono.
    """

    streaming_transcripts: bool = False
    native_vad: bool = False
    dtmf: bool = False
    interruption: bool = False
    input_formats: List[str] = field(default_factory=list)
    output_formats: List[str] = field(default_factory=list)


class UnsupportedCapabilityError(RuntimeError):
    """
    Raised when a script step requests a capability the adapter does not
    advertise. The message names the adapter and the missing capability so
    users can pick a different adapter or fall back to a capability-free
    alternative (e.g., interrupt(after=seconds) instead of after_words).
    """

    def __init__(self, adapter_name: str, capability: str, hint: str = ""):
        self.adapter_name = adapter_name
        self.capability = capability
        suffix = f" {hint}" if hint else ""
        super().__init__(
            f"Adapter {adapter_name!r} does not support capability {capability!r}. "
            f"See the adapter capability matrix at docs/voice/capability-matrix.md.{suffix}"
        )
