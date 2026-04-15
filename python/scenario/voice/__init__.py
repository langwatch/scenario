"""
Voice agent support for Scenario.

Per the source proposal (§1): voice testing uses the same ``scenario.run()``
entrypoint, the same script DSL, and the same judge. What changes is the
medium — audio instead of text.

Public surface:
    - VoiceAgentAdapter — base class for voice-capable agents
    - AudioChunk — canonical internal audio (PCM16 @ 24kHz mono)
    - AdapterCapabilities / UnsupportedCapabilityError — capability matrix
    - VoiceRecording / VoiceEvent / LatencyMetrics — result-side types
    - AudioSegment — per-speaker slice of the recording
    - synthesize / STTProvider / set_stt_provider / get_stt_provider —
      TTS + STT plumbing
    - WebRTCVadFallback — SDK-side VAD for adapters without native VAD
    - create_audio_message / extract_audio / message_has_audio — message helpers
"""

from __future__ import annotations

from .adapter import VoiceAgentAdapter
from .adapters import (
    ElevenLabsAgent,
    GeminiLiveAgent,
    LiveKitAgent,
    OpenAIRealtimeAgent,
    PipecatAgent,
    TwilioAgent,
    VapiAgent,
    WebRTCAgent,
    WebSocketAgent,
    WebSocketProtocol,
)
from .audio_chunk import AudioChunk, silent_chunk
from .capabilities import AdapterCapabilities, UnsupportedCapabilityError
from .interruption import CONTEXTUAL_PROMPT, InterruptionConfig
from .messages import create_audio_message, extract_audio, message_has_audio
from .recording import AudioSegment, LatencyMetrics, VoiceEvent, VoiceRecording
from .stt import (
    OpenAISTTProvider,
    STTProvider,
    get_stt_provider,
    set_stt_provider,
    transcribe,
)
from .tts import register_tts_provider, synthesize
from .vad import WebRTCVadFallback

__all__ = [
    "AdapterCapabilities",
    "AudioChunk",
    "AudioSegment",
    "CONTEXTUAL_PROMPT",
    "ElevenLabsAgent",
    "GeminiLiveAgent",
    "InterruptionConfig",
    "LatencyMetrics",
    "LiveKitAgent",
    "OpenAIRealtimeAgent",
    "OpenAISTTProvider",
    "PipecatAgent",
    "STTProvider",
    "TwilioAgent",
    "UnsupportedCapabilityError",
    "VapiAgent",
    "VoiceAgentAdapter",
    "VoiceEvent",
    "VoiceRecording",
    "WebRTCAgent",
    "WebRTCVadFallback",
    "WebSocketAgent",
    "WebSocketProtocol",
    "create_audio_message",
    "extract_audio",
    "get_stt_provider",
    "message_has_audio",
    "register_tts_provider",
    "set_stt_provider",
    "silent_chunk",
    "synthesize",
    "transcribe",
]
