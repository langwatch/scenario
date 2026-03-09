"""
Example: Testing an agent that returns streaming responses

This test demonstrates handling agents that stream their responses in chunks
rather than returning a complete message at once. The server uses real LLM streaming.
"""

import asyncio
import json
from aiohttp import web
import aiohttp
import pytest
import pytest_asyncio
import scenario
from openai import AsyncOpenAI

# Base URL for the test server (set during server startup)
base_url = ""


class StreamingAgentAdapter(scenario.AgentAdapter):
    """
    Adapter for testing agents that stream responses in chunks.

    This adapter:
    1. Makes an HTTP POST request to the streaming endpoint
    2. Collects all chunks as they arrive
    3. Returns the complete response after streaming completes
    """

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        # Request streaming response from your agent
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{base_url}/chat/stream",
                json={"messages": input.messages},
            ) as response:
                # Collect all chunks into a single response
                full_response = ""

                # Read stream chunk by chunk
                async for chunk in response.content.iter_any():
                    # Decode chunk and append to full response
                    full_response += chunk.decode("utf-8")

                # Return complete response after all chunks received
                return full_response


# OpenAI client for LLM
client = AsyncOpenAI()


async def stream_handler(request: web.Request) -> web.StreamResponse:
    """
    HTTP endpoint that streams LLM responses chunk by chunk.

    This uses chunked transfer encoding to send the response progressively.
    """
    data = await request.json()
    messages = data["messages"]

    # Determine last user message content
    last_msg = messages[-1]
    content = last_msg["content"]
    if not isinstance(content, str):
        content = ""

    # Set up streaming response
    response = web.StreamResponse()
    response.headers["Content-Type"] = "text/plain"
    response.headers["Transfer-Encoding"] = "chunked"
    await response.prepare(request)

    # Stream response using real LLM
    stream = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": "You are a helpful weather assistant. Provide brief, friendly responses, immediately. Pretend like you have access to a weather API and make up the weather.",
            },
            {"role": "user", "content": content},
        ],
        temperature=0.7,
        stream=True,
    )

    # Stream chunks to client
    async for chunk in stream:
        if chunk.choices[0].delta.content:
            await response.write(chunk.choices[0].delta.content.encode("utf-8"))

    await response.write_eof()
    return response


@pytest_asyncio.fixture
async def test_server():
    """
    Start a test HTTP server before tests and shut it down after.

    This server simulates a deployed agent endpoint with streaming.
    """
    global base_url

    # Create web application
    app = web.Application()
    app.router.add_post("/chat/stream", stream_handler)

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
async def test_streaming_response(test_server):
    """
    Test agent via HTTP endpoint with streaming response.

    This test verifies:
    - Adapter correctly handles streaming chunks
    - Complete response is assembled from chunks
    - Agent provides relevant weather information
    - Full scenario flow works with streaming
    """
    result = await scenario.run(
        name="Streaming weather response",
        description="User asks about weather and receives streamed response",
        agents=[
            scenario.UserSimulatorAgent(model="openai/gpt-4o-mini"),
            StreamingAgentAdapter(),
            scenario.JudgeAgent(
                model="openai/gpt-4o-mini",
                criteria=[
                    "Agent should provide weather information",
                    "Response should be complete and coherent",
                ],
            ),
        ],
        script=[
            scenario.user("What's the weather forecast in Amsterdam?"),
            scenario.agent(),
            scenario.judge(),
        ],
        set_id="python-examples",
    )

    assert result.success
