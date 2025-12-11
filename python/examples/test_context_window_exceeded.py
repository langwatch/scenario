"""
Example demonstrating context window exceeded error handling.

This example shows what happens when an agent generates content
that exceeds the judge's context window.
"""

import pytest
import scenario


class VerboseAgent(scenario.AgentAdapter):
    """Agent that returns a response large enough to exceed context limits."""

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        # ~200k chars should exceed most model context limits
        giant_response = "Here's some weather data:\n" + ("x" * 200_000)
        return {"role": "assistant", "content": giant_response}


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_context_window_exceeded():
    """
    Demonstrates what happens when agent response exceeds context window.

    Uses gpt-3.5-turbo-0125 (cheap, 16k context) to trigger context overflow.
    The scenario raises ContextWindowExceededError with a clear message.
    """
    with pytest.raises(Exception) as exc_info:
        await scenario.run(
            name="context overflow test",
            description="User asks for weather info",
            agents=[
                VerboseAgent(),
                scenario.UserSimulatorAgent(model="gpt-4o-mini"),
                scenario.JudgeAgent(
                    model="gpt-3.5-turbo-0125",  # cheap model, 16k context
                    criteria=["Agent should provide weather info"],
                ),
            ],
            script=[
                scenario.user(),  # UserSimulator generates message
                scenario.agent(),  # VerboseAgent returns huge response
                scenario.proceed(),  # Let scenario play out, judge will fail
            ],
        )

    # Error message clearly indicates the problem and which agent caused it
    error_msg = str(exc_info.value)
    print(error_msg)
    assert (
        "JudgeAgent" in error_msg
    ), f"Error should identify JudgeAgent, got: {error_msg}"
    assert (
        "token" in error_msg.lower() or "context" in error_msg.lower()
    ), f"Error should mention tokens or context, got: {error_msg}"
