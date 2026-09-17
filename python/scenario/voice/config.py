"""Per-run voice configuration carried by :class:`ScenarioConfig`."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..config.voice_models import OPENAI_STT_MODEL
from .stt import ElevenLabsSTTProvider, OpenAISTTProvider, STTProvider


class SttConfig(BaseModel):
    """Descriptor form of an STT provider, for example ``openai/gpt-4o-transcribe``."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    model: str
    language: Optional[str] = None
    api_key: Optional[str] = Field(default=None, exclude=True)


class TtsConfig(BaseModel):
    """Per-run TTS routing and credentials for the user simulator."""

    model_config = ConfigDict(extra="forbid")

    voice: str
    api_key: Optional[str] = Field(default=None, exclude=True)

    @model_validator(mode="after")
    def _reject_unsupported_api_key(self) -> "TtsConfig":
        if self.api_key:
            provider, _, _ = self.voice.partition("/")
            if provider.lower() not in {"openai", "elevenlabs"}:
                raise ValueError(
                    f"TTS provider {provider!r} does not support a per-run api_key."
                )
        return self


class VoiceConfig(BaseModel):
    """Voice settings that travel with one scenario run to every agent call."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    stt: Optional[Any] = None
    tts: Optional[TtsConfig] = None

    @field_validator("stt", mode="before")
    @classmethod
    def _coerce_stt_descriptor(cls, value: Any) -> Any:
        if isinstance(value, Mapping):
            return SttConfig.model_validate(value)
        return value

    def snapshot(self) -> "VoiceConfig":
        """Copy this carrier and its descriptor values for one run.

        Explicit ``STTProvider`` instances are shared on purpose: a run that
        names one uses that exact object. Descriptor values (``SttConfig`` /
        ``TtsConfig``) are copied so a caller mutating its own descriptors
        cannot change a run that already started.
        """
        copy = self.model_copy()
        if isinstance(copy.stt, SttConfig):
            copy.stt = copy.stt.model_copy()
        if isinstance(copy.tts, TtsConfig):
            copy.tts = copy.tts.model_copy()
        return copy


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
        return OpenAISTTProvider(
            model or OPENAI_STT_MODEL,
            api_key=config.api_key,
            language=config.language,
        )
    if provider == "elevenlabs":
        if config.language:
            raise ValueError("ElevenLabs STT does not support the language descriptor.")
        return ElevenLabsSTTProvider(
            api_key=config.api_key,
            model=model or None,
        )
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
        stt=stt if stt is not None else OpenAISTTProvider(),
        tts=(option_level.tts if option_level and option_level.tts else None)
        or (scenario_level.tts if scenario_level else None),
    )


def _as_voice_config(value: Any) -> Optional[VoiceConfig]:
    if value is None:
        return None
    if isinstance(value, VoiceConfig):
        return value
    if isinstance(value, Mapping):
        return VoiceConfig.model_validate(value)
    raise TypeError(
        f"voice expects a VoiceConfig, a mapping, or None; got {type(value).__name__}."
    )
