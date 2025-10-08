"""
Example: Testing an agent that streams OpenAI responses via SSE

The handler forwards OpenAI's native chunk format directly.
The adapter parses the SSE stream and extracts content from OpenAI chunks.
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


class SSEAgentAdapter(scenario.AgentAdapter):
    """
    Adapter for testing agents that stream OpenAI responses via SSE.

    Parses SSE stream, extracts content from OpenAI chunk format, and returns complete response.
    """

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        # Request SSE stream from your agent
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{base_url}/chat/sse",
                headers={
                    "Accept": "text/event-stream",  # Indicate we expect SSE format
                    "Content-Type": "application/json",
                },
                json={"messages": input.messages},
            ) as response:
                full_response = ""
                buffer = ""

                # Read stream chunk by chunk
                async for chunk in response.content.iter_any():
                    # Decode chunk and add to buffer
                    buffer += chunk.decode("utf-8")

                    # Process complete lines
                    lines = buffer.split("\n")
                    buffer = (
                        lines[-1] if lines else ""
                    )  # Keep incomplete line in buffer

                    # Parse SSE format: "data: {...}\n"
                    for line in lines[:-1]:
                        if line.startswith("data: "):
                            data = line[6:]  # Remove "data: " prefix
                            if data != "[DONE]":
                                try:
                                    # Parse OpenAI chunk structure
                                    chunk = json.loads(data)
                                    content = (
                                        chunk.get("choices", [{}])[0]
                                        .get("delta", {})
                                        .get("content")
                                    )
                                    if content:
                                        full_response += content
                                except (json.JSONDecodeError, KeyError, IndexError):
                                    pass

                # Return complete response after stream ends
                return full_response


# OpenAI client for LLM
client = AsyncOpenAI()


async def sse_handler(request: web.Request) -> web.StreamResponse:
    """
    HTTP endpoint that forwards OpenAI streaming chunks in SSE format.
    """
    data = await request.json()
    messages = data["messages"]

    # Determine last user message content
    last_msg = messages[-1]
    content = last_msg["content"]
    if not isinstance(content, str):
        content = ""

    # Set up SSE response headers
    response = web.StreamResponse()
    response.headers["Content-Type"] = "text/event-stream"
    response.headers["Cache-Control"] = "no-cache"
    response.headers["Connection"] = "keep-alive"
    await response.prepare(request)

    # Stream response using real LLM
    stream = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": "You are a helpful weather assistant. Provide brief, friendly responses. Pretend you have access to weather data. Pretend like you have access to a weather API and make up the weather.",
            },
            {"role": "user", "content": content},
        ],
        temperature=0.7,
        stream=True,
    )

    # Forward OpenAI chunks in SSE format
    async for chunk in stream:
        chunk_dict = chunk.model_dump()
        await response.write(f"data: {json.dumps(chunk_dict)}\n\n".encode("utf-8"))

    # Send completion marker
    await response.write(b"data: [DONE]\n\n")

    await response.write_eof()
    return response


@pytest_asyncio.fixture
async def test_server():
    """
    Start a test HTTP server before tests and shut it down after.

    This server simulates a deployed agent endpoint with SSE format.
    """
    global base_url

    # Create web application
    app = web.Application()
    app.router.add_post("/chat/sse", sse_handler)

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


@pytest.mark.asyncio
async def test_sse_response(test_server):
    """
    Test agent that streams OpenAI responses via SSE.

    Verifies adapter parses OpenAI chunks and extracts complete response.
    """
    result = await scenario.run(
        name="SSE weather response",
        description="User asks about weather and receives SSE-formatted stream",
        agents=[
            scenario.UserSimulatorAgent(model="openai/gpt-4o-mini"),
            SSEAgentAdapter(),
            scenario.JudgeAgent(
                model="openai/gpt-4o-mini",
                criteria=[
                    "Agent should provide weather information",
                    "Response should be complete and coherent",
                ],
            ),
        ],
        script=[
            scenario.user("What's the weather like in Tokyo today?"),
            scenario.agent(),
            scenario.judge(),
        ],
        set_id="python-examples",
    )

    assert result.success
