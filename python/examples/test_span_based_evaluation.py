"""
Span-Based Evaluation Example

Demonstrates how the judge evaluates internal agent operations via spans:
- Custom span tracking (HTTP calls, database queries)
- Model usage verification
- Tool execution visibility

The judge sees the full execution trace, not just the conversation.
"""

import asyncio
import json
import pytest
import scenario
from opentelemetry import trace
from function_schema import get_function_schema
import litellm


# Get a tracer for creating custom spans
tracer = trace.get_tracer("order-processing-agent")


def check_inventory(product_id: str) -> dict:
    """
    Check if an item is in stock.

    Args:
        product_id: The product ID to check

    Returns:
        Inventory status for the product
    """
    return {"in_stock": True, "quantity": 42, "product_id": product_id}


class ObservableAgent(scenario.AgentAdapter):
    """
    Agent that creates observable custom spans during execution.
    """

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        # Include thread_id so spans are associated with this scenario
        thread_id = input.thread_id

        # Custom span: HTTP call to fraud detection service
        with tracer.start_as_current_span(
            "http.fraud_check",
            attributes={
                "langwatch.thread.id": thread_id,
                "http.method": "POST",
                "http.url": "https://api.fraudservice.com/check",
                "http.status_code": 200,
            },
        ) as fraud_span:
            await asyncio.sleep(0.03)  # Simulate network latency
            fraud_span.set_attribute("fraud.risk_score", 0.1)

        # Custom span: Database query
        with tracer.start_as_current_span(
            "db.query",
            attributes={
                "langwatch.thread.id": thread_id,
                "db.system": "postgresql",
                "db.operation": "SELECT",
                "db.statement": "SELECT * FROM customers WHERE id = $1",
            },
        ):
            await asyncio.sleep(0.02)  # Simulate DB latency

        # LLM call with tool usage
        tools = [check_inventory]
        response = litellm.completion(
            model="openai/gpt-4.1-mini",
            messages=[
                {
                    "role": "system",
                    "content": """You are an order processing assistant.
When asked about products, use the check_inventory tool.""",
                },
                *input.messages,
            ],
            tools=[
                {"type": "function", "function": get_function_schema(tool)}
                for tool in tools
            ],
            tool_choice="auto",
        )

        message = response.choices[0].message  # type: ignore[union-attr]

        # Handle tool calls
        if message.tool_calls:
            tools_by_name = {tool.__name__: tool for tool in tools}
            tool_responses = []

            for tool_call in message.tool_calls:
                tool_name = tool_call.function.name
                tool_args = json.loads(tool_call.function.arguments)

                if tool_name in tools_by_name:
                    # Create span for tool execution
                    with tracer.start_as_current_span(
                        f"tool.{tool_name}",
                        attributes={
                            "langwatch.thread.id": thread_id,
                            "tool.name": tool_name,
                            "tool.arguments": json.dumps(tool_args),
                        },
                    ) as tool_span:
                        result = tools_by_name[tool_name](**tool_args)
                        tool_span.set_attribute("tool.result", json.dumps(result))

                    tool_responses.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "content": json.dumps(result),
                        }
                    )

            # Make follow-up call with tool results
            follow_up = litellm.completion(
                model="openai/gpt-4.1-mini",
                messages=[
                    {
                        "role": "system",
                        "content": "You are an order processing assistant.",
                    },
                    *input.messages,
                    message,
                    *tool_responses,
                ],
            )
            return follow_up.choices[0].message.content or ""  # type: ignore[union-attr]

        return message.content or ""


@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_span_based_evaluation():
    """
    Verifies that custom spans and tool calls are visible to the judge.

    The judge evaluates not just the conversation, but also:
    - Custom HTTP spans (fraud check)
    - Database query spans
    - Tool execution traces
    """
    result = await scenario.run(
        name="span-based evaluation demo",
        description="""
            A customer asks about product SKU-123 availability.
            The agent should check inventory and respond.
        """,
        agents=[
            ObservableAgent(),
            scenario.UserSimulatorAgent(model="openai/gpt-4.1-mini"),
            scenario.JudgeAgent(
                model="openai/gpt-4.1",
                criteria=[
                    "A fraud check HTTP call was made (http.fraud_check span exists)",
                    "A database query was performed (db.query span exists)",
                    "The check_inventory tool was called for the product",
                ],
            ),
        ],
        script=[
            scenario.user("Is product SKU-123 in stock?"),
            scenario.agent(),
            scenario.judge(),
        ],
        max_turns=5,
        set_id="python-examples",
    )

    print(f"\nResult: {result}")
    print(f"Success: {result.success}")
    print(f"Reasoning: {result.reasoning}")
    if result.passed_criteria:
        print(f"Passed criteria: {result.passed_criteria}")
    if result.failed_criteria:
        print(f"Failed criteria: {result.failed_criteria}")

    assert result.success, f"Expected success but got: {result.reasoning}"
