"""
Span-Based Evaluation with LangWatch Decorators

This example demonstrates using LangWatch's higher-level instrumentation API
to create custom spans that the judge can evaluate. This approach is useful when:
- You want a simpler, more Pythonic API
- You're already using LangWatch for observability
- You prefer decorators over context managers

Key concepts:
- Use `@langwatch.span()` decorator for function-level spans
- Use `langwatch.get_current_span()` to access the current span
- Use `span.set_attributes()` to add OpenTelemetry attributes
- Set `langwatch.thread.id` attribute to associate spans with the scenario

See also: test_span_based_evaluation_native_otel.py for native OpenTelemetry API.
"""

import asyncio
import json
import pytest
import scenario
import langwatch
from function_schema import get_function_schema
import litellm


def check_inventory(product_id: str) -> dict:
    """
    Check if an item is in stock.

    Args:
        product_id: The product ID to check

    Returns:
        Inventory status for the product
    """
    return {"in_stock": True, "quantity": 42, "product_id": product_id}


class LangWatchDecoratorAgent(scenario.AgentAdapter):
    """
    Agent instrumented with LangWatch decorator-based spans.

    Uses @langwatch.span() decorator and langwatch.get_current_span()
    to create spans that are visible to the judge during evaluation.
    """

    def __init__(self) -> None:
        """Initialize the agent."""
        super().__init__()
        self._thread_id: str = ""

    @langwatch.span(name="http.fraud_check", type="span")
    async def _check_fraud(self) -> None:
        """
        Simulate an HTTP call to a fraud detection service.

        Uses LangWatch span decorator with get_current_span().set_attributes()
        for adding OpenTelemetry attributes.
        """
        span = langwatch.get_current_span()
        span.set_attributes(
            {
                "langwatch.thread.id": self._thread_id,
                "http.method": "POST",
                "http.url": "https://api.fraudservice.com/check",
                "http.status_code": 200,
            }
        )
        await asyncio.sleep(0.03)  # Simulate network latency
        # LangWatch: Add dynamic attribute after initial creation
        span.set_attributes({"fraud.risk_score": 0.1})

    @langwatch.span(name="db.query", type="span")
    async def _query_database(self) -> None:
        """
        Simulate a database query.

        Demonstrates setting all attributes in a single set_attributes() call.
        """
        span = langwatch.get_current_span()
        span.set_attributes(
            {
                "langwatch.thread.id": self._thread_id,
                "db.system": "postgresql",
                "db.operation": "SELECT",
                "db.statement": "SELECT * FROM customers WHERE id = $1",
            }
        )
        await asyncio.sleep(0.02)  # Simulate DB latency

    @langwatch.span(type="tool")
    def _execute_tool(self, tool_name: str, tool_func: object, tool_args: dict) -> dict:
        """
        Execute a tool with LangWatch span instrumentation.

        The span name defaults to the function name when not specified.
        Type is set to "tool" to indicate this is a tool execution.
        """
        span = langwatch.get_current_span()
        span.set_attributes(
            {
                "langwatch.thread.id": self._thread_id,
                "tool.name": tool_name,
                "tool.arguments": json.dumps(tool_args),
            }
        )
        result = tool_func(**tool_args)  # type: ignore[operator]
        span.set_attributes({"tool.result": json.dumps(result)})
        return result  # type: ignore[return-value]

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        """Process input and return agent response."""
        # IMPORTANT: thread_id links spans to this scenario run
        self._thread_id = input.thread_id

        # LangWatch: Decorated async methods create spans automatically
        await self._check_fraud()
        await self._query_database()

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
                    # LangWatch: Use decorated method for tool execution
                    result = self._execute_tool(
                        tool_name=tool_name,
                        tool_func=tools_by_name[tool_name],
                        tool_args=tool_args,
                    )

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
async def test_langwatch_decorator_span_evaluation():
    """
    Verifies that LangWatch decorator spans are visible to the judge.

    This test demonstrates that spans created with @langwatch.span() decorator
    and updated via langwatch.get_current_span().set_attributes() are captured
    and available for judge evaluation.

    The judge can verify:
    - HTTP call spans (http.fraud_check)
    - Database query spans (db.query)
    - Tool execution spans (_execute_tool with tool type)
    """
    result = await scenario.run(
        name="langwatch decorator span evaluation",
        description="""
            A customer asks about product SKU-123 availability.
            The agent should check inventory and respond.
        """,
        agents=[
            LangWatchDecoratorAgent(),
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
