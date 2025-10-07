"""
Example: Testing an agent that returns JSON responses

This test demonstrates handling agents that return complete JSON responses via HTTP POST.
The server uses a real LLM (OpenAI GPT-4o-mini) to generate responses.
"""

import asyncio
import json
from aiohttp import web
import aiohttp
import pytest
import scenario
from openai import AsyncOpenAI

# Base URL for the test server (set during server startup)
base_url = ""


class JsonAgentAdapter(scenario.AgentAdapter):
    """
    Adapter for testing agents that return JSON responses.

    This adapter:
    1. Extracts the most recent user message from conversation history
    2. Makes an HTTP POST request to the agent endpoint
    3. Parses the JSON response and returns the agent's message
    """

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        # Extract the most recent user message from the conversation
        last_message = input.messages[-1]

        # Handle both string content and multipart content (images, files, etc.)
        content = (
            last_message["content"]
            if isinstance(last_message["content"], str)
            else last_message["content"][0]["text"]
        )

        # Make HTTP POST request to your agent's endpoint
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{base_url}/chat",
                json={"message": content},
            ) as response:
                # Parse JSON response and return the agent's message
                result = await response.json()
                return result["response"]  # Adjust field name to match your API


# OpenAI client for LLM
client = AsyncOpenAI()


async def chat_handler(request: web.Request) -> web.Response:
    """
    HTTP endpoint that receives a message and returns an LLM response.

    This simulates a production agent endpoint that uses a real LLM.
    """
    data = await request.json()
    message = data["message"]

    # Generate response using real LLM
    response = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": "You are a helpful weather assistant. Provide brief, friendly responses. Pretend like you have access to a weather API and make up the weather.",
            },
            {"role": "user", "content": message},
        ],
        temperature=0.7,
    )

    # Return JSON response
    return web.json_response({"response": response.choices[0].message.content})


@pytest.fixture
async def test_server():
    """
    Start a test HTTP server before tests and shut it down after.

    This server simulates a deployed agent endpoint.
    """
    global base_url

    # Create web application
    app = web.Application()
    app.router.add_post("/chat", chat_handler)

    # Start server on random available port
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "localhost", 0)
    await site.start()

    # Get the actual port assigned
    port = site._server.sockets[0].getsockname()[1]
    base_url = f"http://localhost:{port}"

    yield

    # Cleanup: stop server
    await runner.cleanup()


@pytest.mark.asyncio
async def test_json_response(test_server):
    """
    Test agent via HTTP endpoint with JSON response.

    This test verifies:
    - Adapter correctly calls HTTP endpoint
    - JSON response is properly parsed
    - Agent provides relevant weather information
    - Full scenario flow works end-to-end
    """
    result = await scenario.run(
        name="JSON weather inquiry",
        description="User asks about weather and receives JSON response",
        agents=[
            scenario.UserSimulatorAgent(model="openai/gpt-4o-mini"),
            JsonAgentAdapter(),
            scenario.JudgeAgent(
                model="openai/gpt-4o-mini",
                criteria=[
                    "Agent should provide weather information",
                    "Response should be relevant to the query",
                ],
            ),
        ],
        script=[
            scenario.user("What's the weather like today?"),
            scenario.agent(),
            scenario.judge(),
        ],
        set_id="python-examples",
    )

    assert result.success
