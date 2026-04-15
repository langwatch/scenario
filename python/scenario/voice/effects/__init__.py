"""
Audio effects pipeline for the voice user simulator (§4.5).

Per the TTS cache key locked decision: effects are applied AFTER the TTS
cache hit and are never baked into the cached audio.

Each effect is a ``Callable[[bytes], bytes]`` that takes PCM16 @ 24kHz mono
and returns PCM16 @ 24kHz mono. This keeps them trivially composable.

Accents are handled via TTS voice selection (``voice="elevenlabs/raj_indian_english"``),
not via post-processing. There is no ``accent`` effect — by design (§4.5 L536-544).
"""

from __future__ import annotations

from .custom import custom
from .noise import background_noise, multiple_voices, static
from .prosody import high_volume, low_volume, speaking_fast, speaking_slow
from .quality import (
    breaking_up,
    echo,
    low_quality,
    packet_loss,
    phone_quality,
    robotic,
)

__all__ = [
    "background_noise",
    "breaking_up",
    "custom",
    "echo",
    "high_volume",
    "low_quality",
    "low_volume",
    "multiple_voices",
    "packet_loss",
    "phone_quality",
    "robotic",
    "speaking_fast",
    "speaking_slow",
    "static",
]
