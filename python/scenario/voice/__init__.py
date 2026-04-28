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
    - transcribe_segments — post-hoc STT over a VoiceRecording (AC-15 judge
      fallback path for non-multimodal judges, proposal §4.3)
    - WebRTCVadFallback — SDK-side VAD for adapters without native VAD
    - create_audio_message / extract_audio / message_has_audio — message helpers
"""

from __future__ import annotations

from .adapter import VoiceAgentAdapter
from .adapters import (
    ComposableVoiceAgent,
    ElevenLabsAgentAdapter,
    ElevenLabsVoiceAgent,
    GeminiLiveAgentAdapter,
    LiveKitAgentAdapter,
    OpenAIRealtimeAgentAdapter,
    PipecatAgentAdapter,
    TwilioAgentAdapter,
    VapiAgentAdapter,
    WebRTCAgentAdapter,
    WebSocketAgentAdapter,
    WebSocketProtocol,
)
from .audio_chunk import AudioChunk, silent_chunk
from .capabilities import AdapterCapabilities, UnsupportedCapabilityError
from .interruption import CONTEXTUAL_PROMPT, InterruptionConfig
from .messages import create_audio_message, extract_audio, message_has_audio
from .recording import AudioSegment, LatencyMetrics, VoiceEvent, VoiceRecording
from .stt import (
    ElevenLabsSTTProvider,
    OpenAISTTProvider,
    STTProvider,
    get_stt_provider,
    set_stt_provider,
    transcribe,
)
from ._transcribe import transcribe_segments
from .tts import register_tts_provider, synthesize
from .vad import WebRTCVadFallback

__all__ = [
    "AdapterCapabilities",
    "AudioChunk",
    "AudioSegment",
    "CONTEXTUAL_PROMPT",
    "ComposableVoiceAgent",
    "ElevenLabsAgentAdapter",
    "ElevenLabsSTTProvider",
    "ElevenLabsVoiceAgent",
    "GeminiLiveAgentAdapter",
    "InterruptionConfig",
    "LatencyMetrics",
    "LiveKitAgentAdapter",
    "OpenAIRealtimeAgentAdapter",
    "OpenAISTTProvider",
    "PipecatAgentAdapter",
    "STTProvider",
    "TwilioAgentAdapter",
    "UnsupportedCapabilityError",
    "VapiAgentAdapter",
    "VoiceAgentAdapter",
    "VoiceEvent",
    "VoiceRecording",
    "WebRTCAgentAdapter",
    "WebRTCVadFallback",
    "WebSocketAgentAdapter",
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
    "transcribe_segments",
]
