"""
Unit tests for UserSimulatorAgent voice support (§4.2).
"""

import pytest

import scenario


def test_user_sim_without_voice_unchanged():
    sim = scenario.UserSimulatorAgent(model="openai/gpt-4.1-mini")
    assert sim.voice is None
    assert sim.audio_effects == []
    assert sim.interrupt_probability == 0.0


def test_user_sim_accepts_voice_parameter():
    sim = scenario.UserSimulatorAgent(model="openai/gpt-4.1-mini", voice="openai/nova")
    assert sim.voice == "openai/nova"


def test_user_sim_accepts_persona():
    sim = scenario.UserSimulatorAgent(
        model="openai/gpt-4.1-mini",
        persona="Frustrated customer who speaks quickly",
    )
    assert sim.persona == "Frustrated customer who speaks quickly"


def test_user_sim_accepts_audio_effects_list():
    effect = lambda b: b  # noqa: E731
    sim = scenario.UserSimulatorAgent(
        model="openai/gpt-4.1-mini",
        voice="openai/nova",
        audio_effects=[effect],
    )
    assert sim.audio_effects == [effect]


def test_user_sim_interrupt_probability_validated():
    with pytest.raises(ValueError):
        scenario.UserSimulatorAgent(model="openai/gpt-4.1-mini", interrupt_probability=1.5)
    with pytest.raises(ValueError):
        scenario.UserSimulatorAgent(model="openai/gpt-4.1-mini", interrupt_probability=-0.1)


def test_user_sim_interrupt_probability_accepted_in_range():
    sim = scenario.UserSimulatorAgent(model="openai/gpt-4.1-mini", interrupt_probability=0.3)
    assert sim.interrupt_probability == 0.3
