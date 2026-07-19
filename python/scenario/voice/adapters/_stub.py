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
            "Options: (1) run this scenario as an @integration test against a "
            f"live endpoint, (2) subclass {adapter_name} and implement "
            "send_audio/recv_audio — and re-audit the inherited "
            "`capabilities` ClassVar so the matrix matches what your subclass "
            "can actually do. Claiming streaming_transcripts=True in a "
            "subclass without a real transcript stream will silently break "
            "after_words interruption."
        )
        self.adapter_name = adapter_name


class TransportNotConnectedError(PendingTransportError):
    """Raised by the pre-turn guard when a real adapter's transport is not
    connected at ``call()`` time — the socket dropped, or ``connect()`` was
    never called.

    Subclasses :class:`PendingTransportError` so existing
    ``except PendingTransportError`` handlers (and the uniform pre-turn gate
    that mirrors the TS ``PendingTransportError`` throw) still catch it, but
    carries an ACTIONABLE message: the transport IS implemented, so the fix is
    to ``connect()``/reconnect, not to subclass and implement send/recv.
    """

    def __init__(self, adapter_name: str) -> None:
        # Bypass PendingTransportError.__init__ (its message tells the user to
        # implement a transport that already exists) and set an accurate one.
        NotImplementedError.__init__(
            self,
            f"{adapter_name}: transport is not connected. The executor calls "
            "connect() at scenario start and disconnect() at end; if you drive "
            "the adapter directly, call connect() (or reconnect) before call(). "
            "A dropped socket also lands here — check the transport/session logs.",
        )
        self.adapter_name = adapter_name
