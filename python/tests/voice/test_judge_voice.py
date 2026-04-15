"""
Unit tests for voice-aware JudgeAgent auto-detection (§4.3).
"""

import scenario


def _judge(model="openai/gpt-4o", **kwargs):
    return scenario.JudgeAgent(criteria=["c"], model=model, **kwargs)


def test_include_audio_auto_enabled_for_multimodal_model():
    j = _judge(model="openai/gpt-4o")
    assert j.effective_include_audio(conversation_has_audio=True) is True


def test_include_audio_auto_disabled_for_text_only_model():
    j = _judge(model="openai/gpt-4.1-mini")
    assert j.effective_include_audio(conversation_has_audio=True) is False


def test_include_audio_false_when_no_audio_in_conversation():
    j = _judge(model="openai/gpt-4o")
    assert j.effective_include_audio(conversation_has_audio=False) is False


def test_explicit_include_audio_false_forces_text_only_even_with_multimodal_model():
    j = _judge(model="openai/gpt-4o", include_audio=False)
    assert j.effective_include_audio(conversation_has_audio=True) is False


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


def test_gemini_is_detected_as_audio_capable():
    j = _judge(model="google/gemini-2.5-flash")
    assert j._model_supports_audio() is True
