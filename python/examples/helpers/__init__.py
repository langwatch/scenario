"""
Helper modules for audio conversation examples.

This package contains utilities for:
- OpenAI voice agent implementation
- Audio file encoding for transmission in messages
- Judge agent wrappers for audio transcription
"""

from .openai_voice_agent import OpenAiVoiceAgent
from .audio_helpers import encode_audio_to_base64
from .judge_audio_wrapper import wrap_judge_for_audio, sanitize_messages_for_audio

__all__ = [
    "OpenAiVoiceAgent",
    "encode_audio_to_base64",
    "wrap_judge_for_audio",
    "sanitize_messages_for_audio",
]
