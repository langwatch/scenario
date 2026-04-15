"""
Shared helpers for adapter stubs that have not had their real transport
implementations written yet.

Phase 2 scaffolds the platform adapter classes so the capability matrix, the
public import surface, and constructor validation can be tested at the @unit
level. The actual wire protocols for Pipecat / LiveKit / Twilio / ElevenLabs
/ Vapi / WebRTC ship in a follow-up phase.

Until then, ``send_audio`` / ``recv_audio`` raise a clearly-worded
``NotImplementedError`` so scenarios that accidentally use them in @unit
tests fail loudly instead of silently producing empty audio.
"""

from __future__ import annotations


class PendingTransportError(NotImplementedError):
    """Raised by stub adapters when their transport code has not landed yet."""

    def __init__(self, adapter_name: str) -> None:
        super().__init__(
            f"{adapter_name}: transport implementation is not yet wired up. "
            "Use an @integration test with a live endpoint, or subclass "
            f"{adapter_name} and override send_audio / recv_audio."
        )
        self.adapter_name = adapter_name
