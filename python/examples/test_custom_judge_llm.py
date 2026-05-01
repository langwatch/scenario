"""
Example test demonstrating a fully custom LLM-based judge.

This example shows how to build a judge that calls an LLM directly using
litellm, with a strict JSON schema for structured output. This gives you
full control over the prompt, model, and response parsing.
"""

import json

import pytest
import litellm
import scenario
from scenario.types import AgentInput, AgentReturnTypes, ScenarioResult

scenario.configure(default_model="openai/gpt-4.1-mini")


class CustomLLMJudge(scenario.AgentAdapter):
    role = scenario.AgentRole.JUDGE

    def __init__(self, criteria: list[str], model: str = "openai/gpt-4.1-mini"):
        self.criteria = criteria
        self.model = model

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        if not input.judgment_request:
            return []

        effective_criteria = (
            input.judgment_request.criteria
            if input.judgment_request.criteria is not None
            else self.criteria
        )

        # Build a simple transcript
        transcript = "\n".join(
            f"{m['role']}: {m.get('content', '[tool call]')}" for m in input.messages
        )

        criteria_list = "\n".join(f"- {c}" for c in effective_criteria)

        criteria_numbered = "\n".join(
            f"{i + 1}. {c}" for i, c in enumerate(effective_criteria)
        )

        response = litellm.completion(
            model=self.model,
            temperature=0.0,
            messages=[
                {
                    "role": "system",
                    "content": f"""Evaluate this conversation against the criteria.

Criteria:
{criteria_numbered}

Return one result per criterion, in the same order as listed above.""",
                },
                {"role": "user", "content": transcript},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "evaluation",
                    "schema": {
                        "type": "object",
                        "properties": {
                            "pass": {"type": "boolean"},
                            "reasoning": {"type": "string"},
                            "results": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "met": {"type": "boolean"},
                                    },
                                    "required": ["met"],
                                    "additionalProperties": False,
                                },
                            },
                        },
                        "required": ["pass", "reasoning", "results"],
                        "additionalProperties": False,
                    },
                },
            },
        )

        result = json.loads(response.choices[0].message.content)  # type: ignore[union-attr]

        passed = [c for i, c in enumerate(effective_criteria) if result["results"][i]["met"]]
        failed = [c for i, c in enumerate(effective_criteria) if not result["results"][i]["met"]]

        return ScenarioResult(
            success=result["pass"],
            messages=[],
            reasoning=result["reasoning"],
            passed_criteria=passed,
            failed_criteria=failed,
        )


class PoliteAgent(scenario.AgentAdapter):
    """A mock agent that always responds politely."""

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "Hello! I'd be happy to help you with that. How can I assist you today?"


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_custom_llm_judge():
    """Custom LLM judge evaluates a polite agent response."""
    result = await scenario.run(
        name="custom LLM judge",
        description="User greets the agent",
        agents=[
            PoliteAgent(),
            scenario.UserSimulatorAgent(),
            CustomLLMJudge(
                criteria=[
                    "Agent responds with a greeting",
                    "Agent offers to help",
                ],
            ),
        ],
        script=[
            scenario.user("Hi there!"),
            scenario.agent(),
            scenario.judge(),
        ],
    )

    assert result.success
    assert len(result.passed_criteria) == 2
