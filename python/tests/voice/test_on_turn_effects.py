"""
Feature AC #44 — Effects that vary during conversation via on_turn hook.

Source §4.5 L548-557. Tests that ``ScenarioState.set_effects(...)`` replaces
the audio-effects list on every ``UserSimulatorAgent`` so that the
``proceed(on_turn=lambda s: s.set_effects([...]))`` pattern works.
"""

from __future__ import annotations

import pytest

from scenario.scenario_state import ScenarioState
from scenario.user_simulator_agent import UserSimulatorAgent


def _make_state_with_user_sim(user_sim: UserSimulatorAgent) -> ScenarioState:
    executor = type(
        "E", (), {"agents": [user_sim], "_voice_timeline": []}
    )()
    state = ScenarioState.model_construct(
        description="probe",
        messages=[],
        thread_id="t-1",
        current_turn=1,
        config=None,  # type: ignore[arg-type]
    )
    state._executor = executor  # type: ignore[misc]
    return state


def test_set_effects_replaces_audio_effects_on_user_simulator():
    def effect_a(data: bytes) -> bytes:
        return data + b"A"

    def effect_b(data: bytes) -> bytes:
        return data + b"B"

    user_sim = UserSimulatorAgent(model="openai/gpt-4.1-mini", audio_effects=[effect_a])
    state = _make_state_with_user_sim(user_sim)

    state.set_effects([effect_b])

    assert user_sim.audio_effects == [effect_b]


def test_set_effects_is_idempotent_for_same_turn():
    def fx(data: bytes) -> bytes:
        return data

    user_sim = UserSimulatorAgent(model="openai/gpt-4.1-mini", audio_effects=[])
    state = _make_state_with_user_sim(user_sim)

    state.set_effects([fx])
    state.set_effects([fx])

    assert user_sim.audio_effects == [fx]


def test_set_effects_is_a_copy_not_a_reference():
    """Mutating the caller's list after set_effects must not affect the agent."""
    def fx(data: bytes) -> bytes:
        return data

    user_sim = UserSimulatorAgent(model="openai/gpt-4.1-mini", audio_effects=[])
    state = _make_state_with_user_sim(user_sim)

    caller_list = [fx]
    state.set_effects(caller_list)
    caller_list.clear()

    assert user_sim.audio_effects == [fx]


def test_set_effects_noop_when_no_user_simulator():
    """Scenarios without a user simulator silently accept set_effects calls."""
    executor = type("E", (), {"agents": [], "_voice_timeline": []})()
    state = ScenarioState.model_construct(
        description="probe",
        messages=[],
        thread_id="t-1",
        current_turn=0,
        config=None,  # type: ignore[arg-type]
    )
    state._executor = executor  # type: ignore[misc]

    state.set_effects([])  # Must not raise.


def test_on_turn_callback_can_vary_effects_per_turn_via_current_turn():
    """
    Simulates the proposal §4.5 canonical pattern:
    on_turn=lambda s: s.set_effects([noise(volume=0.1 * s.current_turn)]).
    """
    applied_volumes: list[float] = []

    def make_effect(volume: float):
        def apply(data: bytes) -> bytes:
            applied_volumes.append(volume)
            return data
        return apply

    user_sim = UserSimulatorAgent(model="openai/gpt-4.1-mini", audio_effects=[])
    state = _make_state_with_user_sim(user_sim)

    def on_turn(s: ScenarioState):
        s.set_effects([make_effect(0.1 * s.current_turn)])

    for turn in (1, 2, 3):
        state.current_turn = turn
        on_turn(state)
        # Invoke the effect to record which turn's volume it captured.
        user_sim.audio_effects[0](b"\x00")

    assert applied_volumes == pytest.approx([0.1, 0.2, 0.3])
