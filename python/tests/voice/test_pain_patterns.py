"""
Unit-level mechanism probes for the five §8 pain patterns.

These are the user-value scenarios that justify the voice feature. Each
pain-pattern scenario in ``specs/voice-agents.feature`` is tagged
``@integration`` (full end-to-end exercise runs under the nightly voice
workflow). The tests here probe the *mechanisms* that enable each pattern,
on mocked adapters, so the implementation seam is regression-guarded even
without live providers.

Scope (AC #62–#66, source §8 L1231-1269):

1. long hold — ``scenario.sleep(N)`` pauses the script without transmitting audio
2. accent misunderstanding — user simulator accepts accent-bearing voice strings
3. multi-intent — a single user turn with multiple intents reaches the agent intact
4. background handoff — background_noise mixing does not alter the user transcript
5. emotional escalation — a callable script step can inspect messages for escalation markers
"""

from __future__ import annotations

import time

import pytest

import scenario
from scenario.scenario_state import ScenarioState
from scenario.voice import AdapterCapabilities, AudioChunk, VoiceAgentAdapter


class _SpyAdapter(VoiceAgentAdapter):
    capabilities = AdapterCapabilities(dtmf=False)

    def __init__(self):
        super().__init__()
        self.sent: list[AudioChunk] = []

    async def connect(self):
        pass

    async def disconnect(self):
        pass

    async def send_audio(self, chunk):
        self.sent.append(chunk)

    async def recv_audio(self, timeout):
        return AudioChunk(data=b"")


class _FakeState:
    """Minimal ScenarioState stand-in for script-step unit tests."""

    def __init__(self, agents, messages=None):
        self.agents = agents
        self.messages = messages if messages is not None else []
        self._executor = type("E", (), {"agents": agents})()


# -------------------------------------------------------------------- #
# Pain pattern 1 — "long hold" feedback during 15s tool call           #
# -------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_pain_pattern_long_hold_sleep_transmits_no_audio():
    """
    The mechanism: ``scenario.sleep(N)`` pauses the script for N seconds
    without sending any audio to the transport. That's what lets a
    "long hold" pain-pattern scenario work — the agent can emit filler
    audio during the sleep while the user-side stays silent.
    """
    adapter = _SpyAdapter()
    state = _FakeState([adapter])
    step = scenario.sleep(0.2)
    t0 = time.monotonic()
    await step(state)  # type: ignore[arg-type,misc]
    elapsed = time.monotonic() - t0
    assert elapsed >= 0.15
    assert adapter.sent == []


# -------------------------------------------------------------------- #
# Pain pattern 2 — "accent misunderstanding" loop escape                #
# -------------------------------------------------------------------- #


def test_pain_pattern_accent_voice_selection_is_respected():
    """
    The mechanism: the user simulator accepts any ``voice="provider/name"``
    string and stores it verbatim. Accent is handled via voice selection
    (per proposal §4.5 prohibition on an ``accent`` effect), so it must
    survive through config without normalization.
    """
    sim = scenario.UserSimulatorAgent(
        model="openai/gpt-4.1-mini",
        voice="elevenlabs/raj_indian_english",
    )
    assert sim.voice == "elevenlabs/raj_indian_english"


def test_pain_pattern_accent_style_override_is_scoped_to_a_step():
    """
    The mechanism: the user simulator supports a per-step one-shot override
    of ``voice_style`` and ``audio_effects``. That's what lets a scenario
    dial difficulty up or down mid-conversation (e.g., switch to a clearer
    voice after the "loop escape" criterion fires) without reconfiguring
    the whole simulator. Verified via the internal ``_one_shot_override``
    context manager driven by the executor when ``user(voice_style=...)``
    is used.
    """
    sim = scenario.UserSimulatorAgent(
        model="openai/gpt-4.1-mini",
        voice="elevenlabs/raj_indian_english",
    )
    with sim._one_shot_override(voice_style="calm"):
        assert sim._voice_style_override == "calm"
    assert sim._voice_style_override is None
    assert sim.voice == "elevenlabs/raj_indian_english"


# -------------------------------------------------------------------- #
# Pain pattern 3 — "multi-intent" single turn                           #
# -------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_pain_pattern_multi_intent_scripted_user_preserves_content():
    """
    The mechanism: a scripted ``scenario.user("text with multiple
    intents")`` delegates to ``executor.user(content=...)`` which appends
    the full text as a single user message — no splitting, no
    summarization. The judge then sees the complete turn and can assert
    both intents were addressed.
    """
    multi = "Cancel my subscription and also check if I have any credits left"
    step = scenario.user(multi)

    calls: list = []

    async def fake_executor_user(content, *, voice_style=None, audio_effects=None):
        calls.append((content, voice_style, audio_effects))

    executor = type("E", (), {"agents": []})()
    executor.user = fake_executor_user  # type: ignore[attr-defined]

    state = ScenarioState.model_construct(
        description="probe",
        messages=[],
        thread_id="t-1",
        current_turn=0,
        config=None,  # type: ignore[arg-type]
    )
    state._executor = executor  # type: ignore[misc]

    coroutine = step(state)  # type: ignore[arg-type]
    assert coroutine is not None
    await coroutine  # type: ignore[misc]

    assert len(calls) == 1
    assert calls[0][0] == multi


# -------------------------------------------------------------------- #
# Pain pattern 4 — "background handoff" should not trigger agent        #
# -------------------------------------------------------------------- #


def test_pain_pattern_background_noise_is_an_effect_not_a_script_step():
    """
    The mechanism: ``scenario.effects.background_noise(preset)`` returns
    an audio-effect callable that mutates bytes — it is NOT a script step
    and cannot, on its own, enqueue a user turn. This keeps "background
    audio" strictly separate from "user speech" at the type level.

    If it were a script step, the agent could respond to the background
    as if it were user speech — the exact pain pattern this separation
    exists to prevent.
    """
    effect = scenario.effects.background_noise("cafe", volume=0.3)
    assert callable(effect)

    # Applying the effect transforms audio bytes; it does not emit a
    # message or touch the scenario script.
    silent_pcm16 = b"\x00\x00" * 1024
    mixed = effect(silent_pcm16)
    assert isinstance(mixed, (bytes, bytearray))
    assert len(mixed) == len(silent_pcm16)
    assert mixed != silent_pcm16  # mixing added noise energy


def test_pain_pattern_background_noise_composes_with_user_simulator_audio_effects():
    """
    The mechanism for "background handoff": the user simulator's
    ``audio_effects`` list runs AFTER TTS synthesis, so any background
    noise is layered on top of scripted user speech — never injected as
    its own turn. Configuring background effects on the simulator leaves
    the script unchanged.
    """
    sim = scenario.UserSimulatorAgent(
        model="openai/gpt-4.1-mini",
        audio_effects=[scenario.effects.background_noise("cafe", volume=0.2)],
    )
    assert len(sim.audio_effects) == 1
    # The simulator still has no side effects on the scenario script.
    assert callable(sim.audio_effects[0])


# -------------------------------------------------------------------- #
# Pain pattern 5 — "emotional escalation" detection and adjustment      #
# -------------------------------------------------------------------- #


def test_pain_pattern_escalation_persona_is_stored_on_simulator():
    """
    The mechanism: ``UserSimulatorAgent(persona=...)`` stores the
    escalation instruction verbatim. The escalation pain pattern relies
    on the persona text being present in the simulator's system prompt,
    so the LLM driving the simulator actually ramps its tone.
    """
    sim = scenario.UserSimulatorAgent(
        model="openai/gpt-4.1-mini",
        persona="Starts calm; becomes increasingly frustrated each turn",
    )
    assert sim.persona is not None
    assert "frustrated" in sim.persona.lower()


def test_pain_pattern_escalation_detectable_via_callable_step():
    """
    The mechanism: a plain Python callable script step (Example 6.5
    pattern) can walk ``state.messages`` to detect escalation markers —
    without the scenario runner needing a special-cased "escalation
    detection" feature. This is what lets users write custom escalation
    checks on the cheap.
    """
    escalation_words = {"angry", "frustrated", "furious", "fed up"}

    def detect_escalation(state: ScenarioState) -> bool:
        for m in state.messages:
            content = m.get("content")
            if isinstance(content, str) and any(
                w in content.lower() for w in escalation_words
            ):
                return True
        return False

    executor = type("E", (), {"agents": [], "_voice_timeline": []})()
    state = ScenarioState.model_construct(
        description="probe",
        messages=[
            {"role": "user", "content": "I've been on hold forever"},
            {"role": "assistant", "content": "I understand, one moment"},
            {"role": "user", "content": "This is getting frustrated now, come on"},
        ],
        thread_id="t-1",
        current_turn=2,
        config=None,  # type: ignore[arg-type]
    )
    state._executor = executor  # type: ignore[misc]

    assert detect_escalation(state) is True
