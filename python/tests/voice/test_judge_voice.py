"""
Unit tests for voice-aware JudgeAgent auto-detection (§4.3).

After Bundle 3, effective_include_audio delegates to resolve_modality (litellm
advisory) instead of the old substring list.  Tests that depend on the
old model-name→capability mapping now mock resolve_modality directly so they
remain deterministic regardless of the litellm version's advisory data.
"""

import scenario
from unittest.mock import patch
from scenario.voice.modality_resolver import ModalityTier


def _judge(model="openai/gpt-4o", **kwargs):
    return scenario.JudgeAgent(criteria=["c"], model=model, **kwargs)


def test_include_audio_auto_enabled_for_audio_capable_model():
    """A model the resolver marks AUDIO_IN receives audio parts."""
    j = _judge(model="openai/gpt-audio-mini")
    with patch(
        "scenario.judge_agent.resolve_modality",
        return_value=(ModalityTier.AUDIO_IN, []),
    ):
        assert j.effective_include_audio(conversation_has_audio=True) is True


def test_include_audio_auto_disabled_for_text_only_model():
    j = _judge(model="openai/gpt-4.1-mini")
    with patch(
        "scenario.judge_agent.resolve_modality",
        return_value=(ModalityTier.TEXT, []),
    ):
        assert j.effective_include_audio(conversation_has_audio=True) is False


def test_include_audio_false_when_no_audio_in_conversation():
    """Even an audio-capable model returns False when the conversation has no audio."""
    j = _judge(model="openai/gpt-audio-mini")
    with patch(
        "scenario.judge_agent.resolve_modality",
        return_value=(ModalityTier.AUDIO_IN, []),
    ):
        assert j.effective_include_audio(conversation_has_audio=False) is False


def test_explicit_include_audio_false_forces_text_only_even_with_multimodal_model():
    """Explicit include_audio=False wins — resolver is not called (AC3c)."""
    j = _judge(model="openai/gpt-audio-mini", include_audio=False)
    # resolve_modality must NOT be called when include_audio is explicitly set
    with patch(
        "scenario.judge_agent.resolve_modality",
        return_value=(ModalityTier.AUDIO_IN, []),
    ) as mock_resolver:
        result = j.effective_include_audio(conversation_has_audio=True)
    assert result is False
    mock_resolver.assert_not_called()


def test_include_timeline_defaults_true_for_voice_conversations():
    j = _judge()
    assert j.effective_include_timeline(conversation_has_audio=True) is True
    assert j.effective_include_timeline(conversation_has_audio=False) is False


def test_explicit_include_timeline_respected():
    j = _judge(include_timeline=False)
    assert j.effective_include_timeline(conversation_has_audio=True) is False


def test_include_traces_defaults_to_otel_configured():
    j = _judge()
    assert j.effective_include_traces(otel_configured=True) is True
    assert j.effective_include_traces(otel_configured=False) is False


def test_explicit_include_traces_respected():
    j = _judge(include_traces=False)
    assert j.effective_include_traces(otel_configured=True) is False
