"""
Evaluators on scenarios: LangWatch evaluators check the answer against the
expected answer the scenario carries and the SQL the agent ran, next to the
judge verdict. Each mapping is a function of the scenario state, the same
state a script step receives.

Needs LANGWATCH_API_KEY (and LANGWATCH_ENDPOINT for a self-hosted platform).
The evaluators run through the LangWatch evaluate endpoint, so the test is
skipped without a key.
"""

import json
import os

import pytest

import scenario

pytestmark = pytest.mark.skipif(
    not os.getenv("LANGWATCH_API_KEY"),
    reason="LANGWATCH_API_KEY is required to run evaluators through LangWatch",
)

scenario.configure(default_model="openai/gpt-5-mini")

SQL = "SELECT quarter, count(*) FROM chargebacks WHERE merchant = 'ACME Travel' GROUP BY quarter"
ANSWER = "ACME Travel had 12 chargebacks in 2026-Q1 and 9 in 2026-Q2."


class SqlAnalystAgent(scenario.AgentAdapter):
    """An agent that answers with a run_sql tool call and a summary."""

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        return [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_run_sql_1",
                        "type": "function",
                        "function": {"name": "run_sql", "arguments": json.dumps({"sql": SQL})},
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_run_sql_1",
                "content": json.dumps([{"quarter": "2026-Q1", "count": 12}, {"quarter": "2026-Q2", "count": 9}]),
            },
            {"role": "assistant", "content": ANSWER},
        ]


def check_sql_was_run(state: scenario.ScenarioState) -> None:
    """A script step reads the same state the evaluator mappings read."""
    assert state.tool_calls("run_sql").last.input["sql"] == SQL
    assert state.field("expected_answer") == ANSWER


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_answer_and_sql_are_checked_by_evaluators():
    result = await scenario.run(
        name="chargeback totals by quarter",
        description="A fraud analyst asks for the chargebacks per quarter for merchant ACME Travel.",
        agents=[
            SqlAnalystAgent(),
            scenario.UserSimulatorAgent(),
            scenario.JudgeAgent(criteria=["The agent reports chargeback counts per quarter"]),
        ],
        fields={
            "expected_answer": ANSWER,
            "table_schema": "CREATE TABLE chargebacks (id text, merchant text, quarter text)",
        },
        evaluators=[
            # Inferred mappings: output reads the last agent message and
            # expected_output reads the expected_answer field.
            scenario.evaluator("langevals/exact_match", required=True),
            # The SQL the agent ran is the input of the last run_sql call. The
            # lambda and scenario.trace.tool_calls("run_sql").last.input are
            # the same mapping.
            scenario.evaluator(
                "langevals/llm_boolean",
                required=False,
                mappings={"output": lambda state: state.tool_calls("run_sql").last.input},
                settings={
                    "prompt": "Does this SQL group chargebacks by quarter for one merchant? Answer true or false.",
                },
            ),
        ],
        script=[
            scenario.user("How many chargebacks did ACME Travel have per quarter?"),
            scenario.agent(),
            check_sql_was_run,
            scenario.judge(),
        ],
    )

    assert result.success, result.reasoning
    statuses = {evaluation.evaluator_id: evaluation.status for evaluation in result.evaluations}
    assert statuses["langevals/exact_match"] == "passed"
    assert statuses["langevals/llm_boolean"] in ("passed", "failed")
