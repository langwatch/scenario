"""Per-role voice modality resolution.

Declaration-first: explicit per-role modality beats litellm advisory.
Advisory is used as a hint only; mismatch emits a WARNING.
"""
from __future__ import annotations
import logging
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)


class ModalityTier(str, Enum):
    AUDIO_IN = "audio-in"    # LLM receives raw audio parts
    STT_BRIDGE = "stt-bridge"  # audio -> STT -> text before LLM
    TEXT = "text"            # no audio in the stack


class ModalityNegotiationError(Exception):
    """Raised when the declared modality is incompatible with adapter capabilities.

    Message always contains both the declared modality string and the conflicting
    capability value (e.g. 'realtime' and 'mulaw/8000').
    """


def _litellm_advisory(model_id: str) -> bool:
    """Return True if litellm believes model_id can ingest audio input."""
    try:
        import litellm.utils
        return bool(litellm.utils.supports_audio_input(model=model_id))
    except Exception:
        return False


def resolve_modality(
    *,
    declaration: Optional[str],  # None = no explicit declaration
    model_id: str,
) -> tuple[ModalityTier, list[str]]:
    """Resolve the modality tier for a single role.

    Returns (tier, warnings).  Warnings are human-readable strings the caller
    should emit via logger.warning().

    Resolution rules:
    - If declaration is given AND litellm agrees -> use declared tier, no warning.
    - If declaration is given AND litellm disagrees -> use declared tier, emit WARNING.
    - If no declaration -> use litellm advisory as truth, no warning.
    """
    advisory_audio = _litellm_advisory(model_id)

    if declaration is None:
        tier = ModalityTier.AUDIO_IN if advisory_audio else ModalityTier.TEXT
        return tier, []

    # Normalize declaration string to ModalityTier
    try:
        declared_tier = ModalityTier(declaration)
    except ValueError:
        raise ModalityNegotiationError(
            f"Unknown modality declaration {declaration!r}; valid values: "
            + ", ".join(t.value for t in ModalityTier)
        )

    warnings: list[str] = []
    declared_audio = declared_tier == ModalityTier.AUDIO_IN

    if declared_audio and not advisory_audio:
        warnings.append(
            f"Model {model_id!r} declared modality 'audio-in' but litellm "
            f"reports it does NOT support audio input. "
            f"The declared modality 'audio-in' will be used. "
            f"If this is wrong, remove the declaration or file a litellm issue."
        )
    elif not declared_audio and advisory_audio:
        warnings.append(
            f"Model {model_id!r} declared modality {declaration!r} but litellm "
            f"reports it DOES support audio input. "
            f"The declared modality {declaration!r} will be used."
        )

    return declared_tier, warnings


def validate_modality_setup(
    *,
    tier: ModalityTier,
    adapter_input_formats: list[str],
    adapter_name: str,
) -> None:
    """Raise ModalityNegotiationError if tier is statically incompatible with adapter.

    'audio-in' requires a pcm16-family input format. Adapters that only offer
    mulaw/* (telephony) cannot pass audio directly to the LLM.
    """
    if tier == ModalityTier.AUDIO_IN:
        pcm_formats = [f for f in adapter_input_formats if f.startswith("pcm16")]
        if adapter_input_formats and not pcm_formats:
            # Has formats, none are pcm16-compatible — static impossible
            raise ModalityNegotiationError(
                f"Declared modality 'audio-in' is incompatible with adapter "
                f"{adapter_name!r}: input formats {adapter_input_formats!r} "
                f"contain no pcm16 path (conflicting capability: "
                f"{adapter_input_formats[0]!r}). No resample path exists."
            )
