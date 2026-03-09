"""
Example: Testing an agent that returns JSON responses

This test demonstrates handling agents that return complete JSON responses via HTTP POST.
"""

from aiohttp import web
import aiohttp
import pytest
import pytest_asyncio
import scenario

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
        # Extract the most recent user message content
        last_message = input.messages[-1]
        content = last_message["content"]  # type: ignore[typeddict-item]

        # For this example, we assume content is a string
        if not isinstance(content, str):
            raise ValueError("This example only handles string content")

        # Make HTTP POST request to your agent's endpoint
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{base_url}/chat",
                json={"message": content},
                timeout=aiohttp.ClientTimeout(total=30),
            ) as response:
                # Parse JSON response and return the agent's message
                result = await response.json()
                return result["response"]


async def chat_handler(request: web.Request) -> web.Response:
    """
    HTTP endpoint that receives a message and returns a response.

    This simulates a production agent endpoint.
    """
    data = await request.json()
    message = data["message"]

    # In a real application, you would call your LLM here
    # For this example, we return a simple response
    response_text = f"The weather is sunny and 72°F. Your query was: {message}"

    # Return JSON response
    return web.json_response({"response": response_text})


@pytest_asyncio.fixture
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
    server = site._server
    assert server is not None
    port = server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    base_url = f"http://localhost:{port}"

    yield

    # Cleanup: stop server
    await runner.cleanup()


@pytest.mark.flaky(reruns=2)
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
