"""
Architectural probe — Example 6.5: callable-as-script-step pattern.

Source §6.5 L998-1028. Feature AC #58 marks this "NOT OPTIONAL."

The promise: voice doesn't fork the DSL. A plain Python callable can be
dropped into a voice scenario's ``script=[...]`` at any position, receives
``ScenarioState`` when invoked, and can inspect ``state.timeline`` to verify
voice-specific events (tool_call, user_interrupt, etc.) mid-conversation —
not just post-hoc via ``result.timeline``.

These tests exercise the load-bearing seam. If they fail, the feature's
core adaptability claim ("same scenario.run(), same script DSL, just a
different medium") is broken.
"""

from __future__ import annotations

import pytest

from scenario.scenario_state import ScenarioState
from scenario.voice.recording import VoiceEvent


def test_scenario_state_exposes_timeline_attribute():
    """ScenarioState must have a ``timeline`` attribute for callable script steps."""
    assert hasattr(ScenarioState, "timeline") or "timeline" in ScenarioState.model_fields, (
        "ScenarioState is missing a `timeline` attribute. Example 6.5 requires "
        "callables to read `state.timeline` mid-scenario."
    )


@pytest.mark.asyncio
async def test_callable_script_step_sees_tool_call_events_in_timeline(monkeypatch):
    """
    A plain Python callable in ``script=[...]`` receives ScenarioState and
    can inspect ``state.timeline`` to find tool_call VoiceEvents that were
    appended during preceding agent turns.
    """
    from scenario.scenario_executor import ScenarioExecutor
    from scenario.voice import AdapterCapabilities, AudioChunk, VoiceAgentAdapter

    class _SilentAdapter(VoiceAgentAdapter):
        capabilities = AdapterCapabilities(dtmf=False)

        async def connect(self):
            pass

        async def disconnect(self):
            pass

        async def send_audio(self, chunk):  # type: ignore[override]
            pass

        async def recv_audio(self, timeout):  # type: ignore[override]
            return AudioChunk(data=b"")

    captured: dict = {"timeline_at_callable": None}

    def assert_tool_called(state: ScenarioState):
        # This is the exact Example 6.5 pattern from proposal §6.5 L1002-1004.
        captured["timeline_at_callable"] = list(state.timeline)  # type: ignore[attr-defined]
        tool_events = [
            e
            for e in state.timeline  # type: ignore[attr-defined]
            if e.type == "tool_call" and e.name == "get_customer_info"
        ]
        assert len(tool_events) > 0, "Expected tool_call event in timeline"

    adapter = _SilentAdapter()

    # Build a minimal executor and seed the voice timeline directly — we are
    # probing the state→timeline wiring, not the full voice-turn loop.
    executor = ScenarioExecutor.__new__(ScenarioExecutor)
    executor.agents = [adapter]  # type: ignore[attr-defined]
    executor._voice_timeline = [  # type: ignore[attr-defined]
        VoiceEvent(time=0.0, type="user_start_speaking"),
        VoiceEvent(time=1.0, type="user_stop_speaking"),
        VoiceEvent(time=1.1, type="agent_start_speaking"),
        VoiceEvent(
            time=1.5,
            type="tool_call",
            name="get_customer_info",
            args={"id": "C-12345"},
        ),
        VoiceEvent(time=2.0, type="agent_stop_speaking"),
    ]

    state = ScenarioState.model_construct(
        description="probe",
        messages=[],
        thread_id="t-1",
        current_turn=0,
        config=None,  # type: ignore[arg-type]
    )
    state._executor = executor  # type: ignore[misc]

    assert_tool_called(state)

    assert captured["timeline_at_callable"] is not None
    assert any(
        e.type == "tool_call" and e.name == "get_customer_info"
        for e in captured["timeline_at_callable"]
    )


def test_callable_step_raises_when_expected_tool_call_missing():
    """The Example 6.5 assertion must actually fail when the tool wasn't called."""
    from scenario.scenario_executor import ScenarioExecutor

    def assert_tool_called(state: ScenarioState):
        tool_events = [
            e
            for e in state.timeline  # type: ignore[attr-defined]
            if e.type == "tool_call" and e.name == "get_customer_info"
        ]
        assert len(tool_events) > 0, "Expected tool_call event in timeline"

    executor = ScenarioExecutor.__new__(ScenarioExecutor)
    executor._voice_timeline = [  # type: ignore[attr-defined]
        VoiceEvent(time=0.0, type="user_start_speaking"),
        VoiceEvent(time=1.0, type="agent_start_speaking"),
        # No tool_call event.
    ]

    state = ScenarioState.model_construct(
        description="probe",
        messages=[],
        thread_id="t-1",
        current_turn=0,
        config=None,  # type: ignore[arg-type]
    )
    state._executor = executor  # type: ignore[misc]

    with pytest.raises(AssertionError, match="tool_call"):
        assert_tool_called(state)
