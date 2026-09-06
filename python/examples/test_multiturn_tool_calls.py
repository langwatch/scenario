"""
E2E test: 10-turn multiturn conversation with tool calls.

Verifies that the user simulator works correctly after the agent makes tool
calls (role reversal must summarize tool messages as plain text).
"""

import json
import random

import pytest
import litellm
import scenario
from function_schema import get_function_schema


# ── Tool definitions ──────────────────────────────────────────────────────────


def search_products(query: str) -> str:
    """
    Search for products by name or category.

    Args:
        query: The search query for products.

    Returns:
        A list of matching products with prices.
    """
    products = {
        "headphones": [
            "Wireless Headphones Pro - $79.99",
            "Budget Earbuds - $19.99",
            "Noise Cancelling Over-Ear - $149.99",
        ],
        "laptop": [
            "UltraBook 14 - $999.99",
            "Gaming Laptop X - $1,499.99",
            "Budget Chromebook - $299.99",
        ],
        "keyboard": [
            "Mechanical RGB Keyboard - $89.99",
            "Wireless Compact Keyboard - $49.99",
        ],
    }
    for key, items in products.items():
        if key in query.lower():
            return json.dumps(items)
    return json.dumps(["No products found for: " + query])


def check_stock(product_name: str) -> str:
    """
    Check the stock availability for a specific product.

    Args:
        product_name: The exact product name to check stock for.

    Returns:
        Stock availability information.
    """
    in_stock = random.choice([True, True, True, False])
    qty = random.randint(1, 50) if in_stock else 0
    return json.dumps(
        {
            "product": product_name,
            "in_stock": in_stock,
            "quantity": qty,
            "ships_in": "2-3 business days" if in_stock else "out of stock",
        }
    )


TOOLS = [search_products, check_stock]


# ── Agent implementation ──────────────────────────────────────────────────────


@scenario.cache()
def shopping_agent(
    messages: list,
    response_messages: list | None = None,
    max_tool_turns: int = 5,
) -> scenario.AgentReturnTypes:
    if response_messages is None:
        response_messages = []
    if max_tool_turns <= 0:
        raise RuntimeError("Exceeded max tool-call turns in shopping_agent")
    response = litellm.completion(
        model="openai/gpt-4.1-nano",
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a helpful online shopping assistant. "
                    "Use the search_products tool to find items and "
                    "check_stock to verify availability. "
                    "Be concise and helpful."
                ),
            },
            *messages,
            *response_messages,
        ],
        tools=[
            {"type": "function", "function": get_function_schema(tool)}
            for tool in TOOLS
        ],
        tool_choice="auto",
    )

    message = response.choices[0].message  # type: ignore[union-attr]  # litellm's ModelResponse.choices is typed loosely; real completions always return this shape

    if message.tool_calls:
        tools_by_name = {tool.__name__: tool for tool in TOOLS}
        tool_responses = []
        for tool_call in message.tool_calls:
            name = tool_call.function.name
            args = json.loads(tool_call.function.arguments)
            if name in tools_by_name:
                result = tools_by_name[name](**args)
                tool_responses.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": result,
                    }
                )
            else:
                raise ValueError(f"Tool {name} not found")

        return shopping_agent(
            messages,
            [*response_messages, message, *tool_responses],
            max_tool_turns - 1,
        )

    return [*response_messages, message]  # type: ignore[list-item]  # litellm's Message isn't a ChatCompletionMessageParam dict, but AgentReturnTypes accepts either shape at runtime


# ── Test ──────────────────────────────────────────────────────────────────────


@pytest.mark.agent_test
@pytest.mark.asyncio
@pytest.mark.flaky(reruns=2)
async def test_multiturn_shopping_with_tool_calls():
    """10-turn conversation where the agent makes tool calls on multiple turns.

    The user simulator must handle role-reversed tool messages correctly
    throughout the entire conversation without crashing.
    """

    class ShoppingAgent(scenario.AgentAdapter):
        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            return shopping_agent(input.messages)

    def check_search_tool_used(state: scenario.ScenarioState) -> None:
        assert state.has_tool_call("search_products"), "Agent should have used search_products"

    def check_stock_tool_used(state: scenario.ScenarioState) -> None:
        assert state.has_tool_call("check_stock"), "Agent should have used check_stock"

    result = await scenario.run(
        name="10-turn shopping with tool calls",
        description=(
            "A user browses an online shop, asking about different products, "
            "checking stock, comparing options, and eventually deciding what to buy. "
            "The agent uses search and stock-check tools throughout."
        ),
        agents=[
            ShoppingAgent(),
            scenario.UserSimulatorAgent(model="openai/gpt-4.1-nano"),
            scenario.JudgeAgent(
                model="openai/gpt-4.1",
                criteria=[
                    "The agent used tools to look up products when the user asked about them",
                    "The agent provided helpful product information and pricing",
                    "The agent maintained context across the full conversation",
                ],
            ),
        ],
        script=[
            # Turn 1: user asks about headphones -> agent should search
            scenario.user("hey do you have any headphones"),
            scenario.agent(),
            check_search_tool_used,
            # Turn 2: user asks follow-up (user sim runs with tool messages in history)
            scenario.user(),
            scenario.agent(),
            # Turn 3: user asks about a different category
            scenario.user("what about keyboards"),
            scenario.agent(),
            # Turn 4: free-form follow-up from user sim
            scenario.user(),
            scenario.agent(),
            # Turn 5: user asks to check stock
            scenario.user("can you check if the mechanical keyboard is in stock"),
            scenario.agent(),
            check_stock_tool_used,
            # Turn 6-10: let the user sim drive the rest of the conversation
            scenario.user(),
            scenario.agent(),
            scenario.user(),
            scenario.agent(),
            scenario.user(),
            scenario.agent(),
            scenario.user(),
            scenario.agent(),
            scenario.user(),
            scenario.agent(),
            # Judge the full conversation
            scenario.judge(),
        ],
        set_id="python-examples",
    )

    assert result.success
