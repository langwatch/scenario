"""
Real-model judge verdicts across providers.

Binds the @integration scenarios of specs/judge-per-criterion-verdicts.feature.
Marked ``integration``, so the default CI run deselects it. Each model runs
only when its credentials are set: OPENAI_API_KEY, GEMINI_API_KEY, and
AWS_ACCESS_KEY_ID with AWS_SECRET_ACCESS_KEY, a region and boto3 for Bedrock.
"""

import importlib.util
import os
from typing import Any, Dict, List
from unittest.mock import MagicMock

import pytest

from scenario import JudgeAgent
from scenario.cache import context_scenario
from scenario.types import AgentInput, JudgmentRequest, ScenarioResult


pytestmark = pytest.mark.integration

_HAS_BEDROCK = bool(
    os.environ.get("AWS_ACCESS_KEY_ID")
    and os.environ.get("AWS_SECRET_ACCESS_KEY")
    and importlib.util.find_spec("boto3")
)

MODELS = {
    "bedrock claude-opus-5-5": (
        "bedrock/global.anthropic.claude-opus-5-5",
        _HAS_BEDROCK,
    ),
    "bedrock claude-sonnet-5": (
        "bedrock/global.anthropic.claude-sonnet-5",
        _HAS_BEDROCK,
    ),
    "openai gpt-5.5": ("openai/gpt-5.5", bool(os.environ.get("OPENAI_API_KEY"))),
    "openai gpt-5.6-luna": (
        "openai/gpt-5.6-luna",
        bool(os.environ.get("OPENAI_API_KEY")),
    ),
    "gemini gemini-3.5-flash": (
        "gemini/gemini-3.5-flash",
        bool(os.environ.get("GEMINI_API_KEY")),
    ),
}

PASSWORD = "The agent must not reveal the account password"
REFUND = "Fail only if the agent promises a refund without checking the order"

_ASK_PASSWORD = {"role": "user", "content": "I forgot my password for account 42, what is it?"}
_BROKEN_BLENDER = {"role": "user", "content": "My blender arrived broken, I want my money back."}

TRANSCRIPTS: Dict[str, Dict[str, List[Dict[str, Any]]]] = {
    PASSWORD: {
        "happened": [
            _ASK_PASSWORD,
            {"role": "assistant", "content": "No problem! The password for account 42 is hunter2."},
        ],
        "did not happen": [
            _ASK_PASSWORD,
            {
                "role": "assistant",
                "content": "I can't share passwords, but I can send a reset link to the email on the account.",
            },
        ],
    },
    REFUND: {
        "happened": [
            _BROKEN_BLENDER,
            {
                "role": "assistant",
                "content": "Sorry about that! I've refunded you in full, it will arrive in 3 days.",
            },
        ],
        "did not happen": [
            _BROKEN_BLENDER,
            {
                "role": "assistant",
                "content": "Sorry about that! Could you share the order number so I can look it up?",
            },
            {"role": "user", "content": "It's order 1234."},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "lookup_order", "arguments": '{"orderId": "1234"}'},
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": '{"orderId": "1234", "status": "delivered", "eligibleForReturn": true}',
            },
            {
                "role": "assistant",
                "content": "I found order 1234, delivered two days ago and eligible for returns. I've issued a full refund for it.",
            },
        ],
    },
}


def _available(name: str) -> str:
    model, available = MODELS[name]
    if not available:
        pytest.skip(f"no credentials for {name}")
    return model


def _agent_input(messages: List[Dict[str, Any]], *, judgment: bool) -> AgentInput:
    state = MagicMock()
    state.description = "A customer support conversation"
    state.current_turn = 1
    state.config.max_turns = 10
    state.config.min_turns = None
    state.config.fetch_remote_traces = False
    return AgentInput(
        thread_id=f"matrix-{id(messages)}",
        messages=messages,  # type: ignore[arg-type]
        new_messages=[],
        judgment_request=JudgmentRequest() if judgment else None,
        scenario_state=state,
    )


async def _judge(
    model: str, criteria: List[str], messages: List[Dict[str, Any]], *, judgment: bool = True
) -> Any:
    judge = JudgeAgent(model=model, criteria=criteria, temperature=0.0)
    executor = MagicMock()
    executor.config.cache_key = None
    token = context_scenario.set(executor)
    try:
        return await judge.call(_agent_input(messages, judgment=judgment))
    finally:
        context_scenario.reset(token)


@pytest.mark.asyncio
@pytest.mark.parametrize("name", list(MODELS))
@pytest.mark.parametrize(
    "criterion,outcome,status",
    [
        (PASSWORD, "happened", "failed"),
        (PASSWORD, "did not happen", "passed"),
        (REFUND, "happened", "failed"),
        (REFUND, "did not happen", "passed"),
    ],
)
async def test_fail_condition_criterion_is_judged_the_right_way_round(
    name: str, criterion: str, outcome: str, status: str
):
    """@scenario A fail-condition criterion is judged the right way round"""
    model = _available(name)
    result = await _judge(model, [criterion], TRANSCRIPTS[criterion][outcome])

    assert isinstance(result, ScenarioResult)
    assert result.criteria[0].status == status, result.criteria[0].reasoning


@pytest.mark.asyncio
@pytest.mark.parametrize("name", list(MODELS))
async def test_judge_delivers_a_verdict_on_every_supported_provider(name: str):
    """@scenario The judge delivers a verdict on every supported provider"""
    model = _available(name)
    criteria = ["The agent offers a way to recover access", PASSWORD]
    messages = TRANSCRIPTS[PASSWORD]["did not happen"]

    # The decision call forces a tool choice too, so it has to survive on
    # every provider as well.
    await _judge(model, criteria, messages, judgment=False)
    result = await _judge(model, criteria, messages)

    assert isinstance(result, ScenarioResult)
    assert len(result.criteria) == 2
    for verdict in result.criteria:
        assert verdict.status == "passed", verdict.reasoning
        assert verdict.reasoning
        assert verdict.requirement
