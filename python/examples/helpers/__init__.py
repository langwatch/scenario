"""
Helper modules for audio conversation examples.

This package contains utilities for:
- The shared LLM-judge criteria the audio examples all judge against
- OpenAI voice agent implementation
- Audio file encoding for transmission in messages
- Judge agent wrappers for audio transcription
"""

from .audio_judge_criteria import AUDIO_JUDGE_CRITERIA
from .openai_voice_agent import OpenAiVoiceAgent
from .audio_helpers import encode_audio_to_base64
from .judge_audio_wrapper import wrap_judge_for_audio, sanitize_messages_for_audio

__all__ = [
    "AUDIO_JUDGE_CRITERIA",
    "OpenAiVoiceAgent",
    "encode_audio_to_base64",
    "wrap_judge_for_audio",
    "sanitize_messages_for_audio",
]
