"""
System-prompt tests for UserSimulatorAgent VOICE mode (issue #597).

The default user-simulator system prompt is text-chat-style ("very short
inputs, few words, all lowercase, imperative, not periods, like when they
google or talk to chatgpt"). That telegraphic style is wrong for TTS voice
scenarios — spoken users use full clauses, not lowercase-no-punctuation
search fragments. The fix (a coder will land it) adds a VOICE-mode prompt
variant selected when ``self.voice`` is set.

These tests assert on the SYSTEM PROMPT actually sent to the model — fully
deterministic, no live LLM. They use the same seam as
``tests/test_user_simulator_agent.py``: monkeypatch
``scenario.user_simulator_agent.litellm.completion`` with a mock, call
``await sim.call(...)``, then read the captured system prompt at
``mock_completion.call_args.kwargs["messages"][0]["content"]``.

``reverse_roles`` (applied just before the completion call) leaves the
system message untouched at index 0, so index 0 is the system prompt.

Voice mode: ``call()`` runs the generated text through ``_voiceify``, which
performs a live TTS ``synthesize`` call. We patch ``scenario.voice.synthesize``
(imported lazily inside ``_voiceify``) so no network/TTS happens — the prompt
is already captured by the time TTS would run.

Baseline expectation against UNMODIFIED code:
    P-AC1, P-AC2, P-AC4b  -> RED (no voice prompt variant exists yet)
    P-AC3, P-AC4a         -> GREEN (today's behavior)
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from scenario import UserSimulatorAgent
from scenario.cache import context_scenario
from scenario.types import AgentInput
from scenario.voice import AudioChunk

# A valid non-None voice id (same value the existing voice plumbing tests use).
VOICE_ID = "openai/nova"
MODEL = "openai/gpt-4.1-mini"


def _agent_input() -> AgentInput:
    """An AgentInput with a stub scenario_state (mirrors the seam test)."""
    scenario_state = MagicMock()
    scenario_state.description = "Caller wants to book a table for two tonight"
    return AgentInput(
        thread_id="test",
        messages=[],
        new_messages=[],
        scenario_state=scenario_state,
    )


def _mock_completion_response() -> MagicMock:
    """A litellm.completion return whose content is a real non-empty string,
    so the voice path exercises _voiceify (which we stub) rather than its
    early-return-on-empty branch."""
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.content = "hi, id like to book a table"
    return response


async def _capture_system_prompt(sim: UserSimulatorAgent) -> str:
    """Drive ``sim.call`` through the mocked seam and return the system prompt
    (``messages[0]["content"]``) that was sent to ``litellm.completion``.

    ``scenario.voice.synthesize`` is stubbed so voice-mode agents never make a
    live TTS call; the prompt is captured regardless of voice mode.
    """
    # The @scenario_cache decorator reads context_scenario; a cache_key of None
    # disables caching so the mocked completion always runs.
    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)
    try:
        with patch(
            "scenario.user_simulator_agent.litellm.completion",
            return_value=_mock_completion_response(),
        ) as mock_completion, patch(
            "scenario.voice.synthesize",
            new=AsyncMock(return_value=AudioChunk(data=b"", transcript="x")),
        ):
            await sim.call(_agent_input())

        assert mock_completion.called, "litellm.completion was never called"
        return mock_completion.call_args.kwargs["messages"][0]["content"]
    finally:
        context_scenario.reset(token)


# --------------------------------------------------------------------------- #
# P-AC1 — voice prompt is spoken-style (RED today)                            #
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_voice_prompt_is_spoken_style():
    sim = UserSimulatorAgent(model=MODEL, voice=VOICE_ID)
    prompt = await _capture_system_prompt(sim)
    assert "SPEAKING on a phone" in prompt
    assert "full clauses" in prompt


# --------------------------------------------------------------------------- #
# P-AC2 — telegraphic text-chat copy is GONE in voice mode (LOAD-BEARING, RED)#
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_voice_prompt_drops_text_chat_copy():
    sim = UserSimulatorAgent(model=MODEL, voice=VOICE_ID)
    prompt = await _capture_system_prompt(sim)
    assert "all lowercase" not in prompt
    assert "not periods" not in prompt
    assert "like when they google" not in prompt


# --------------------------------------------------------------------------- #
# P-AC3 — text mode unchanged (regression guard, GREEN today)                 #
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_text_prompt_unchanged_when_voice_unset():
    sim = UserSimulatorAgent(model=MODEL)
    assert sim.voice is None  # precondition: voice genuinely unset
    prompt = await _capture_system_prompt(sim)
    assert "all lowercase, imperative, not periods" in prompt


# --------------------------------------------------------------------------- #
# P-AC4a — voice + custom system_prompt short-circuits (regression, GREEN)    #
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_voice_with_custom_system_prompt_short_circuits():
    sim = UserSimulatorAgent(
        model=MODEL,
        voice=VOICE_ID,
        system_prompt="SENTINEL_CUSTOM_PROMPT_XYZ",
    )
    prompt = await _capture_system_prompt(sim)
    assert "SENTINEL_CUSTOM_PROMPT_XYZ" in prompt
    assert "SPEAKING on a phone" not in prompt


# --------------------------------------------------------------------------- #
# P-AC4b — voice + persona composes with the voice variant (RED today)        #
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_voice_with_persona_composes():
    sim = UserSimulatorAgent(
        model=MODEL,
        voice=VOICE_ID,
        persona="SENTINEL_PERSONA_XYZ",
    )
    prompt = await _capture_system_prompt(sim)
    assert "SPEAKING on a phone" in prompt
    assert "SENTINEL_PERSONA_XYZ" in prompt
