"""
Unit tests for per-step voice_style / audio_effects overrides on scenario.user (§4.2).
"""

import scenario


def test_user_sim_one_shot_override_is_scoped_to_context():
    sim = scenario.UserSimulatorAgent(
        model="openai/gpt-4.1-mini",
        voice="openai/nova",
        audio_effects=[lambda b: b],
    )
    default_effects = list(sim.audio_effects)

    with sim._one_shot_override(voice_style="angry", audio_effects=[lambda b: b * 2]):
        assert sim._voice_style_override == "angry"
        assert sim._audio_effects_override != default_effects
        assert sim._effective_audio_effects() != default_effects

    # After the context, defaults are restored.
    assert sim._voice_style_override is None
    assert sim._audio_effects_override is None
    assert sim._effective_audio_effects() == default_effects


def test_user_sim_one_shot_override_nesting_restores_outer_state():
    sim = scenario.UserSimulatorAgent(model="openai/gpt-4.1-mini", voice="openai/nova")

    with sim._one_shot_override(voice_style="outer"):
        assert sim._voice_style_override == "outer"
        with sim._one_shot_override(voice_style="inner"):
            assert sim._voice_style_override == "inner"
        assert sim._voice_style_override == "outer"
    assert sim._voice_style_override is None


def test_scenario_user_accepts_voice_style_and_audio_effects():
    # The ScriptStep builder accepts the kwargs without error.
    step = scenario.user("I'm really upset about this!", voice_style="angry")
    assert callable(step)
    step2 = scenario.user("Hello?", audio_effects=[lambda b: b])
    assert callable(step2)
