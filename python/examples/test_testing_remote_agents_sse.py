"""
Example: Testing an agent that returns Server-Sent Events (SSE)

This demonstrates the SSE format commonly used by OpenAI and similar APIs.
Each chunk is sent as "data: {json}\n\n" and the stream ends with "data: [DONE]\n\n".
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


class SSEAgentAdapter(scenario.AgentAdapter):
    """
    Adapter for testing agents that use Server-Sent Events format.

    This adapter:
    1. Makes an HTTP POST request expecting SSE format
    2. Parses "data: {json}" lines as they arrive
    3. Handles the "[DONE]" completion marker
    4. Returns the complete response
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
                    for line in lines[:-1]:  # Process all complete lines
                        if line.startswith("data: "):
                            data = line[6:]  # Remove "data: " prefix

                            # Check for SSE stream end marker
                            if data != "[DONE]":
                                try:
                                    # Parse JSON and extract content field
                                    parsed = json.loads(data)
                                    full_response += parsed["content"]
                                except (json.JSONDecodeError, KeyError):
                                    # Skip malformed JSON
                                    pass

                # Return complete response after stream ends
                return full_response


# OpenAI client for LLM
client = AsyncOpenAI()


async def sse_handler(request: web.Request) -> web.StreamResponse:
    """
    HTTP endpoint that streams LLM responses in SSE format.

    Each chunk is sent as "data: {json}\n\n" and ends with "data: [DONE]\n\n".
    """
    data = await request.json()
    messages = data["messages"]

    # Determine last user message
    last_msg = messages[-1]
    content = (
        last_msg["content"]
        if isinstance(last_msg["content"], str)
        else last_msg["content"][0].get("text", "")
    )

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

    # Stream chunks in SSE format
    async for chunk in stream:
        if chunk.choices[0].delta.content:
            # SSE format: "data: {json}\n\n"
            sse_data = json.dumps({"content": chunk.choices[0].delta.content})
            await response.write(f"data: {sse_data}\n\n".encode("utf-8"))

    # Send completion marker
    await response.write(b"data: [DONE]\n\n")

    await response.write_eof()
    return response


@pytest.fixture
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
    port = site._server.sockets[0].getsockname()[1]
    base_url = f"http://localhost:{port}"

    yield

    # Cleanup: stop server
    await runner.cleanup()


@pytest.mark.asyncio
async def test_sse_response(test_server):
    """
    Test agent via HTTP endpoint with SSE format.

    This test verifies:
    - Adapter correctly parses SSE format
    - "data: {json}" lines are properly handled
    - [DONE] marker signals completion
    - Agent provides relevant weather information
    - Full scenario flow works with SSE
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
