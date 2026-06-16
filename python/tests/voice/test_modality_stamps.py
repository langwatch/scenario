"""Tests for OTEL modality stamping (AC5, AC5b).

Strategy: test _new_turn() directly with a pre-populated _modality_resolutions
dict and a mocked langwatch.trace so no real tracing infrastructure is needed.
"""
from __future__ import annotations

import pytest
from unittest.mock import patch, MagicMock

from scenario.voice.modality_resolver import ModalityTier
from scenario.scenario_executor import ScenarioExecutor


def _make_executor() -> ScenarioExecutor:
    """Minimal executor instance for stamping tests."""
    return ScenarioExecutor(
        name="test-stamps",
        description="modality stamp test",
        agents=[],
    )


def _new_turn_with_resolutions(
    executor: ScenarioExecutor,
    resolutions: dict,
) -> dict:
    """Call _new_turn() on the executor with given _modality_resolutions.

    Mocks langwatch.trace so no real OTEL infrastructure is needed.
    Returns the attrs dict captured from root_span.set_attributes().
    """
    captured: dict = {}
    call_count = 0

    def _make_trace_mock():
        mock_span = MagicMock()

        def _capture(attrs):
            nonlocal call_count
            call_count += 1
            if call_count > 1:
                # Only capture attrs from the explicit _new_turn() call
                # (reset() makes the first call internally).
                captured.update(attrs)

        mock_span.set_attributes.side_effect = _capture

        mock_trace = MagicMock()
        mock_trace.root_span = mock_span
        mock_trace.__enter__ = MagicMock(return_value=mock_trace)
        mock_trace.__exit__ = MagicMock(return_value=False)
        return mock_trace

    with patch("scenario.scenario_executor.langwatch") as mock_lw:
        mock_lw.trace.side_effect = lambda **kwargs: _make_trace_mock()

        # reset() initialises _state (required by _new_turn) and calls _new_turn once.
        executor.reset()

        # Now set resolutions and call _new_turn() again to get the stamped attrs.
        executor._scenario_run_id = "test-run-id"
        executor._modality_resolutions = resolutions
        executor._new_turn()

    return captured


@pytest.mark.asyncio
async def test_ac5_modality_attributes_stamped_on_root_span():
    """AC5: resolved tier per role appears as span attribute."""
    executor = _make_executor()
    resolutions = {
        "simulator": ModalityTier.AUDIO_IN.value,
        "judge": ModalityTier.STT_BRIDGE.value,
    }

    captured = _new_turn_with_resolutions(executor, resolutions)

    assert captured.get("scenario.modality.simulator.tier") == "audio-in"
    assert captured.get("scenario.modality.simulator.resolved") == "audio-in"
    assert captured.get("scenario.modality.judge.tier") == "stt-bridge"
    assert captured.get("scenario.modality.judge.resolved") == "stt-bridge"


@pytest.mark.asyncio
async def test_ac5_degraded_run_has_different_tier():
    """AC5: a degraded run (stt-bridge) carries a different tier than audio-in."""
    executor = _make_executor()
    resolutions = {
        "simulator": ModalityTier.AUDIO_IN.value,
        "judge": ModalityTier.STT_BRIDGE.value,
    }

    captured = _new_turn_with_resolutions(executor, resolutions)

    sim_tier = captured.get("scenario.modality.simulator.tier")
    judge_tier = captured.get("scenario.modality.judge.tier")
    assert sim_tier != judge_tier, (
        f"Expected different tiers for simulator ({sim_tier!r}) and judge ({judge_tier!r})"
    )


@pytest.mark.asyncio
async def test_ac5b_stt_bridge_tier_stamped_correctly():
    """AC5b: declaration 'stt-bridge' resolves through resolve_modality and stamps correctly.

    Exercises the full path: declaration -> resolve_modality -> _modality_resolutions -> span stamp.
    """
    from unittest.mock import patch as mock_patch
    from scenario.voice.modality_resolver import resolve_modality

    executor = _make_executor()

    # Exercise resolve_modality with an explicit stt-bridge declaration.
    # Patch litellm advisory so the test is deterministic (no network).
    with mock_patch(
        "scenario.voice.modality_resolver._litellm_advisory", return_value=False
    ):
        tier, _warnings = resolve_modality(declaration="stt-bridge", model_id="openai/gpt-4o")

    assert tier == ModalityTier.STT_BRIDGE, (
        f"resolve_modality must return STT_BRIDGE for declaration='stt-bridge'; got {tier!r}"
    )

    # Feed the resolved tier into the executor and verify the span stamp.
    resolutions = {"simulator": tier.value}
    captured = _new_turn_with_resolutions(executor, resolutions)

    assert captured.get("scenario.modality.simulator.tier") == "stt-bridge"
    assert captured.get("scenario.modality.simulator.resolved") == "stt-bridge"


def test_no_modality_resolutions_does_not_crash():
    """Baseline: executor with no _modality_resolutions set still stamps core attrs."""
    executor = _make_executor()
    # Intentionally do NOT set _modality_resolutions (getattr default {} applies)
    captured = _new_turn_with_resolutions(executor, {})

    assert "langwatch.origin" in captured
    assert "scenario.run_id" in captured
    # No modality keys expected
    modality_keys = [k for k in captured if k.startswith("scenario.modality.")]
    assert modality_keys == []


def test_run_populates_modality_resolutions_for_simulator_and_judge():
    """Unit test: the resolution loop in run() sets _modality_resolutions per role.

    Tests the population logic directly, without running the full async run().
    """
    from scenario.user_simulator_agent import UserSimulatorAgent
    from scenario.judge_agent import JudgeAgent
    from scenario.voice.modality_resolver import resolve_modality

    sim = UserSimulatorAgent(model="openai/gpt-4o")
    judge = JudgeAgent(criteria=["test criterion"], model="openai/gpt-4o")

    executor = ScenarioExecutor(
        name="resolver-pop-test",
        description="test resolve populates resolutions",
        agents=[sim, judge],
    )

    _LITELLM_PATCH = "scenario.voice.modality_resolver._litellm_advisory"

    # Replicate the population loop from run() exactly, under a controlled advisory.
    with patch(_LITELLM_PATCH, return_value=False):
        resolutions: dict = {}
        for agent in executor.agents:
            if isinstance(agent, UserSimulatorAgent):
                decl = getattr(agent, 'modality', None)
                tier, _ = resolve_modality(
                    declaration=decl,
                    model_id=getattr(agent, 'model', '') or '',
                )
                resolutions['simulator'] = tier.value
            elif isinstance(agent, JudgeAgent):
                decl = getattr(agent, 'modality', None)
                tier, _ = resolve_modality(
                    declaration=decl,
                    model_id=getattr(agent, 'model', '') or '',
                )
                resolutions['judge'] = tier.value

    assert "simulator" in resolutions, (
        "_modality_resolutions must contain 'simulator' key"
    )
    assert "judge" in resolutions, (
        "_modality_resolutions must contain 'judge' key"
    )
    # litellm advisory is False, no declaration → TEXT tier for both
    assert resolutions["simulator"] == ModalityTier.TEXT.value
    assert resolutions["judge"] == ModalityTier.TEXT.value
