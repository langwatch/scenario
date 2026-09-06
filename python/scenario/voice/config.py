"""Per-run voice configuration carried by :class:`ScenarioConfig`."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict

from ..config.voice_models import OPENAI_STT_MODEL
from .stt import ElevenLabsSTTProvider, OpenAISTTProvider, STTProvider


class SttConfig(BaseModel):
    """Descriptor form of an STT provider, for example ``openai/gpt-4o-transcribe``."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    model: str
    language: Optional[str] = None
    api_key: Optional[str] = None


class TtsConfig(BaseModel):
    """Per-run TTS routing for the user simulator."""

    voice: str
    format: Optional[str] = None
    api_key: Optional[str] = None


class VoiceConfig(BaseModel):
    """Voice settings that travel with one scenario run to every agent call."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    stt: Optional[Any] = None
    tts: Optional[TtsConfig] = None


class ResolvedVoiceConfig(BaseModel):
    """Ready-to-use voice settings; ``stt`` is always a concrete provider."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    stt: Any
    tts: Optional[TtsConfig] = None


def resolve_stt_provider(config: SttConfig) -> STTProvider:
    """Resolve a ``provider/model`` descriptor to its concrete STT provider."""
    provider, _, model = config.model.partition("/")
    provider = provider.lower()
    if provider == "openai":
        return OpenAISTTProvider(model or OPENAI_STT_MODEL)
    if provider == "elevenlabs":
        return ElevenLabsSTTProvider(api_key=config.api_key)
    raise ValueError(
        f"Unknown STT provider {provider!r}. Pass an STTProvider instance or "
        "use an openai/... or elevenlabs/... descriptor."
    )


def _resolve_stt(value: Any) -> Optional[STTProvider]:
    if value is None:
        return None
    if callable(getattr(value, "transcribe", None)):
        return value
    if isinstance(value, Mapping):
        value = SttConfig.model_validate(value)
    if isinstance(value, SttConfig):
        return resolve_stt_provider(value)
    raise TypeError(
        "VoiceConfig.stt expects an STTProvider, SttConfig, or descriptor mapping; "
        f"got {type(value).__name__}."
    )


def resolve_voice_config(
    option_level: Optional[VoiceConfig | Mapping[str, Any]] = None,
    scenario_level: Optional[VoiceConfig | Mapping[str, Any]] = None,
) -> ResolvedVoiceConfig:
    """Resolve the per-run voice carrier, constructing an OpenAI STT default."""
    option_level = _as_voice_config(option_level)
    scenario_level = _as_voice_config(scenario_level)
    stt = _resolve_stt(option_level.stt if option_level else None)
    if stt is None:
        stt = _resolve_stt(scenario_level.stt if scenario_level else None)
    return ResolvedVoiceConfig(
        stt=stt or OpenAISTTProvider(),
        tts=(option_level.tts if option_level and option_level.tts else None)
        or (scenario_level.tts if scenario_level else None),
    )


def _as_voice_config(value: Any) -> Optional[VoiceConfig]:
    if isinstance(value, VoiceConfig):
        return value
    if isinstance(value, Mapping):
        return VoiceConfig.model_validate(value)
    return None
