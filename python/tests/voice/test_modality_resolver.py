"""Tests for per-role voice modality resolution (AC4a, AC4b).

All tests mock _litellm_advisory to avoid live API calls.
"""
from __future__ import annotations

import pytest
from unittest.mock import patch

from scenario.voice.modality_resolver import (
    ModalityNegotiationError,
    ModalityTier,
    resolve_modality,
)

_PATCH_TARGET = "scenario.voice.modality_resolver._litellm_advisory"


class TestNoDeclaration:
    """Advisory drives tier when no declaration is provided."""

    def test_no_declaration_advisory_true_returns_audio_in(self):
        with patch(_PATCH_TARGET, return_value=True):
            tier, warnings = resolve_modality(declaration=None, model_id="gpt-audio-mini")
        assert tier == ModalityTier.AUDIO_IN
        assert warnings == []

    def test_no_declaration_advisory_false_returns_text(self):
        with patch(_PATCH_TARGET, return_value=False):
            tier, warnings = resolve_modality(declaration=None, model_id="gpt-4o")
        assert tier == ModalityTier.TEXT
        assert warnings == []


class TestDeclarationAgreement:
    """No warnings when declaration and advisory agree."""

    def test_declared_audio_in_advisory_true_no_warning(self):
        with patch(_PATCH_TARGET, return_value=True):
            tier, warnings = resolve_modality(declaration="audio-in", model_id="gpt-audio-mini")
        assert tier == ModalityTier.AUDIO_IN
        assert warnings == []

    def test_declared_text_advisory_false_no_warning(self):
        with patch(_PATCH_TARGET, return_value=False):
            tier, warnings = resolve_modality(declaration="text", model_id="gpt-4o")
        assert tier == ModalityTier.TEXT
        assert warnings == []


class TestAC4a:
    """AC4a: declared audio-in on advisory-text model emits a loud warning."""

    def test_declared_audio_in_advisory_false_returns_declared_tier(self):
        """Declaration wins even when litellm disagrees."""
        with patch(_PATCH_TARGET, return_value=False):
            tier, warnings = resolve_modality(declaration="audio-in", model_id="gpt-4o")
        assert tier == ModalityTier.AUDIO_IN

    def test_declared_audio_in_advisory_false_emits_exactly_one_warning(self):
        with patch(_PATCH_TARGET, return_value=False):
            _, warnings = resolve_modality(declaration="audio-in", model_id="gpt-4o")
        assert len(warnings) == 1

    def test_declared_audio_in_advisory_false_warning_mentions_model(self):
        with patch(_PATCH_TARGET, return_value=False):
            _, warnings = resolve_modality(declaration="audio-in", model_id="gpt-4o")
        assert "gpt-4o" in warnings[0]

    def test_declared_audio_in_advisory_false_warning_mentions_audio_in(self):
        with patch(_PATCH_TARGET, return_value=False):
            _, warnings = resolve_modality(declaration="audio-in", model_id="gpt-4o")
        assert "audio-in" in warnings[0]

    def test_declared_audio_in_advisory_false_warning_mentions_litellm(self):
        with patch(_PATCH_TARGET, return_value=False):
            _, warnings = resolve_modality(declaration="audio-in", model_id="gpt-4o")
        assert "litellm" in warnings[0]


class TestAC4b:
    """AC4b: declared text on advisory-audio model emits a mismatch warning."""

    def test_declared_text_advisory_true_returns_declared_tier(self):
        """Declaration wins even when litellm disagrees."""
        with patch(_PATCH_TARGET, return_value=True):
            tier, warnings = resolve_modality(declaration="text", model_id="gpt-audio-mini")
        assert tier == ModalityTier.TEXT

    def test_declared_text_advisory_true_emits_exactly_one_warning(self):
        with patch(_PATCH_TARGET, return_value=True):
            _, warnings = resolve_modality(declaration="text", model_id="gpt-audio-mini")
        assert len(warnings) == 1

    def test_declared_text_advisory_true_warning_mentions_model(self):
        with patch(_PATCH_TARGET, return_value=True):
            _, warnings = resolve_modality(declaration="text", model_id="gpt-audio-mini")
        assert "gpt-audio-mini" in warnings[0]

    def test_declared_text_advisory_true_warning_mentions_mismatch(self):
        """Warning must signal that litellm reports audio support."""
        with patch(_PATCH_TARGET, return_value=True):
            _, warnings = resolve_modality(declaration="text", model_id="gpt-audio-mini")
        # Warning should mention either "text" (declared) or "DOES support" to signal mismatch
        assert "text" in warnings[0] or "DOES support" in warnings[0] or "does support" in warnings[0]

    def test_declared_stt_bridge_advisory_true_emits_warning(self):
        """stt-bridge is also a non-audio-in tier; same mismatch rule applies."""
        with patch(_PATCH_TARGET, return_value=True):
            tier, warnings = resolve_modality(declaration="stt-bridge", model_id="gpt-audio-mini")
        assert tier == ModalityTier.STT_BRIDGE
        assert len(warnings) == 1


class TestUnknownDeclaration:
    """Unknown declaration strings raise ModalityNegotiationError."""

    def test_unknown_declaration_raises(self):
        with patch(_PATCH_TARGET, return_value=False):
            with pytest.raises(ModalityNegotiationError) as exc_info:
                resolve_modality(declaration="video-in", model_id="gpt-4o")
        assert "video-in" in str(exc_info.value)

    def test_error_message_lists_valid_values(self):
        with patch(_PATCH_TARGET, return_value=False):
            with pytest.raises(ModalityNegotiationError) as exc_info:
                resolve_modality(declaration="bogus", model_id="gpt-4o")
        error_msg = str(exc_info.value)
        assert "audio-in" in error_msg
        assert "text" in error_msg
