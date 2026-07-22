"""
End-to-end example: a non-litellm agent adapter with a large tool-call
transcript, judged by a real JudgeAgent.

Reproduces the exact shape of issue #836: an AgentAdapter that never routes
its own tool calls through litellm (so JudgeSpanCollector never sees them)
returns many large tool-call/tool-result messages in one turn. Before the
fix, this content flowed into the judge prompt completely unbounded and the
judge's size-management system (gated only on litellm spans) never
activated.

This test buries a single fact deep inside 27 large tool-call results and
asks the judge to verify it -- proving the judge can still find and use
that fact via the transcript's own discovery tools (expand_transcript /
grep_transcript) instead of the content silently exceeding the judge
model's effective attention ("lost in the middle").
"""

import json

import pytest

import scenario
from scenario.types import AgentInput, AgentReturnTypes

scenario.configure(default_model="openai/gpt-4.1-mini")

NEEDLE_QUERY_INDEX = 13
NEEDLE_FACT = "order_id=ORD-88421 status=REFUNDED refund_amount=204.50"


class NonLitellmSalesAgent(scenario.AgentAdapter):
    """Simulates an agent that talks to its own backend directly (e.g. a
    proprietary REST/SSE API) and never calls litellm itself for tool
    execution -- so none of its tool calls ever become an OpenTelemetry
    span. Returns 27 large tool-call/tool-result message pairs in one turn,
    matching the reporter's real repro shape (issue #836)."""

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        messages = []
        for i in range(27):
            call_id = f"call_{i}"
            messages.append(
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": "run_sql",
                                "arguments": json.dumps({"query": f"SELECT * FROM sales_{i}"}),
                            },
                        }
                    ],
                }
            )
            row = NEEDLE_FACT if i == NEEDLE_QUERY_INDEX else ",".join(
                f"row_{i}_{j}=value_{j}" for j in range(100)
            )
            messages.append({"role": "tool", "tool_call_id": call_id, "content": f"[{row}]"})
        # Deliberately generic -- NEEDLE_FACT must not be restated here. If it
        # were, the judge could pass by reading this summary alone (e.g. via
        # a cheap expand_transcript on just the last message), without ever
        # searching the buried tool result, which would defeat the point of
        # this test: proving the judge can dig a fact out of a large,
        # non-litellm tool-call history rather than relying on it being
        # conveniently restated in the final assistant turn.
        messages.append(
            {
                "role": "assistant",
                "content": "I checked 27 sales records.",
            }
        )
        return messages


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_judge_finds_needle_in_large_non_litellm_transcript():
    """A judge criterion that depends on a fact buried inside a large,
    non-litellm tool-call transcript must still be verifiable -- proving
    #836's transcript-size protection activates for agents that never
    produce spans."""
    result = await scenario.run(
        name="non-litellm large transcript judge",
        description="User asks the agent to check on the status of order ORD-88421.",
        agents=[
            NonLitellmSalesAgent(),
            scenario.UserSimulatorAgent(),
            scenario.JudgeAgent(
                criteria=[
                    "Agent's tool call results confirm order ORD-88421 was refunded for $204.50",
                ],
            ),
        ],
        script=[
            scenario.user("Can you check the status of order ORD-88421?"),
            scenario.agent(),
            scenario.judge(),
        ],
    )

    assert result.success is True, result.reasoning
