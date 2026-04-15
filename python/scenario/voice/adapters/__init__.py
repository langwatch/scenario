"""
Platform-specific voice adapters (Phase 2).

Per the proposal (§7.3): per-platform classes over a unified
``VoiceAgent(transport=...)``. ``PipecatAgent`` means "test my Pipecat agent";
``TwilioAgent`` means "test via phone call"; each has platform-specific
constructor parameters that don't fit cleanly on a generic class.
"""

from __future__ import annotations

from ._stub import PendingTransportError
from .elevenlabs import ElevenLabsAgent
from .gemini_live import GeminiLiveAgent
from .livekit import LiveKitAgent
from .openai_realtime import OpenAIRealtimeAgent
from .pipecat import PipecatAgent
from .twilio import TwilioAgent
from .vapi import VapiAgent
from .webrtc import WebRTCAgent
from .websocket import WebSocketAgent, WebSocketProtocol

__all__ = [
    "ElevenLabsAgent",
    "GeminiLiveAgent",
    "LiveKitAgent",
    "OpenAIRealtimeAgent",
    "PendingTransportError",
    "PipecatAgent",
    "TwilioAgent",
    "VapiAgent",
    "WebRTCAgent",
    "WebSocketAgent",
    "WebSocketProtocol",
]
