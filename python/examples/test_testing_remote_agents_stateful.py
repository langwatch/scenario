"""
Example: Testing an agent that maintains stateful conversations

This test demonstrates handling agents that maintain conversation history server-side
using thread identifiers. The adapter sends only the latest message and thread ID,
while the server maintains the full conversation context.
"""

import asyncio
import json
from aiohttp import web
import aiohttp
import pytest
import pytest_asyncio
import scenario
from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam
from typing import Dict, List, Any

# Base URL for the test server (set during server startup)
base_url = ""


class StatefulAgentAdapter(scenario.AgentAdapter):
    """
    Adapter for testing stateful agents that maintain server-side conversation history.

    This adapter:
    1. Extracts only the latest message (not full history)
    2. Sends the message along with thread ID
    3. Server uses thread ID to look up and maintain full history
    4. Returns the agent's response
    """

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        # Extract the most recent user message content
        last_message = input.messages[-1]
        content = last_message["content"]  # type: ignore[typeddict-item]

        # For this example, we assume content is a string
        if not isinstance(content, str):
            raise ValueError("This example only handles string content")

        # Send only new message + thread ID
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{base_url}/chat",
                json={
                    "message": content,
                    "threadId": input.thread_id,
                },
            ) as response:
                result = await response.json()
                return result["response"]


# OpenAI client for LLM
client = AsyncOpenAI()

# Server-side conversation storage (in production, use a database)
conversations: Dict[str, List[Any]] = {}


async def stateful_handler(request: web.Request) -> web.Response:
    """
    HTTP endpoint that maintains conversation history using thread ID.

    The server:
    1. Receives only the latest message and thread ID
    2. Looks up full conversation history using thread ID
    3. Generates response with complete context
    4. Stores updated history
    """
    data = await request.json()
    message = data["message"]
    thread_id = data["threadId"]

    # Retrieve or initialize conversation history
    history = conversations.get(thread_id, [])

    # Add user message to history
    history.append({"role": "user", "content": message})

    # Generate response with FULL history
    response = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": "You are a helpful weather assistant. Provide brief, friendly responses. Pretend like you have access to a weather API and make up the weather.",
            },
            *history,  # Include full conversation history
        ],
        temperature=0.7,
    )

    assistant_message = response.choices[0].message.content

    # Add assistant response to history
    if assistant_message is not None:
        history.append({"role": "assistant", "content": assistant_message})

    # Store updated history
    conversations[thread_id] = history

    # Return only the new response
    return web.json_response({"response": assistant_message})


@pytest_asyncio.fixture
async def test_server():
    """
    Start a test HTTP server before tests and shut it down after.

    This server simulates a deployed agent endpoint with stateful conversation management.
    """
    global base_url, conversations

    # Clear conversations before each test
    conversations.clear()

    # Create web application
    app = web.Application()
    app.router.add_post("/chat", stateful_handler)

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

    # Cleanup: stop server and clear conversations
    await runner.cleanup()
    conversations.clear()


@pytest.mark.flaky(reruns=2)
@pytest.mark.asyncio
async def test_stateful_conversation(test_server):
    """
    Test agent that maintains conversation state using thread ID.

    This test verifies:
    - Adapter sends only latest message + thread ID
    - Server maintains full conversation history
    - Agent remembers context from previous turns
    - Follow-up questions work correctly
    - Multi-turn conversation flows naturally
    """
    result = await scenario.run(
        name="Stateful weather conversation",
        description="Agent remembers previous turns using thread ID",
        agents=[
            scenario.UserSimulatorAgent(model="openai/gpt-4o-mini"),
            StatefulAgentAdapter(),
            scenario.JudgeAgent(
                model="openai/gpt-4o-mini",
                criteria=[
                    "Agent should remember context from message to message",
                    "Agent should provide relevant follow-up information",
                ],
            ),
        ],
        script=[
            scenario.user("What's the weather like in London?"),
            scenario.agent(),
            scenario.user("Is that normal weather here?"),
            scenario.agent(),
            scenario.judge(),
        ],
        set_id="python-examples",
    )

    assert result.success
