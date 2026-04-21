"""
Platform-specific voice adapters (Phase 2).

Per the proposal (§7.3): per-platform classes over a unified
``VoiceAgent(transport=...)``. ``PipecatAgentAdapter`` means "test my Pipecat agent";
``TwilioAgentAdapter`` means "test via phone call"; each has platform-specific
constructor parameters that don't fit cleanly on a generic class.
"""

from __future__ import annotations

from ._stub import PendingTransportError
from .composable import ComposableVoiceAgent, ElevenLabsVoiceAgent
from .elevenlabs import ElevenLabsAgentAdapter
from .gemini_live import GeminiLiveAgentAdapter
from .livekit import LiveKitAgentAdapter
from .openai_realtime import OpenAIRealtimeAgentAdapter
from .pipecat import PipecatAgentAdapter
from .twilio import TwilioAgentAdapter
from .vapi import VapiAgentAdapter
from .webrtc import WebRTCAgentAdapter
from .websocket import WebSocketAgentAdapter, WebSocketProtocol

__all__ = [
    "ComposableVoiceAgent",
    "ElevenLabsAgentAdapter",
    "ElevenLabsVoiceAgent",
    "GeminiLiveAgentAdapter",
    "LiveKitAgentAdapter",
    "OpenAIRealtimeAgentAdapter",
    "PendingTransportError",
    "PipecatAgentAdapter",
    "TwilioAgentAdapter",
    "VapiAgentAdapter",
    "WebRTCAgentAdapter",
    "WebSocketAgentAdapter",
    "WebSocketProtocol",
]
