"""
Example: Judging a remote HTTP agent on its real traces

This test demonstrates remote trace fetching. The agent under test runs
behind an HTTP endpoint and returns final text only, so the transcript never
shows its internal tool calls. The adapter forwards
``input.propagation_headers`` on the request, the server adopts the trace
context with standard OpenTelemetry propagation, and with
``fetch_remote_traces=True`` the judge fetches the resulting spans from
LangWatch and verifies internal behavior against them instead of trusting
the response text.
"""

import json
from typing import Dict

import aiohttp
import pytest
import pytest_asyncio
from aiohttp import web
from opentelemetry import propagate
from opentelemetry import trace as otel_trace

import scenario

# Base URL for the test server (set during server startup)
base_url = ""


class RemoteAgentAdapter(scenario.AgentAdapter):
    """
    Adapter for an agent deployed behind an HTTP endpoint.

    Spreads ``input.propagation_headers`` onto the outgoing request so the
    server's spans join the scenario turn's trace. That is the only wiring a
    remote agent needs for the judge to see its internal behavior.
    """

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        content = input.last_new_user_message()["content"]
        if not isinstance(content, str):
            raise ValueError("This example only handles string content")

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{base_url}/chat",
                json={"message": content, "threadId": input.thread_id},
                headers=dict(input.propagation_headers),
            ) as response:
                result = await response.json()
                return result["response"]


def _get_weather(city: str) -> str:
    """Pretend weather tool: deterministic so the example stays cheap."""
    return f"The weather in {city} is sunny, 22 degrees Celsius."


async def chat_handler(request: web.Request) -> web.Response:
    """
    HTTP endpoint standing in for a deployed agent.

    Adopts the incoming trace context (``propagate.extract``), so the spans
    it creates land in the same trace the scenario opened for this turn.
    With standard OpenTelemetry HTTP instrumentation this adoption happens
    automatically and the handler needs no tracing code at all.
    """
    data = await request.json()
    message = data["message"]

    context = propagate.extract(dict(request.headers))
    tracer = otel_trace.get_tracer("remote-weather-agent")
    with tracer.start_as_current_span("chat_request", context=context):
        with tracer.start_as_current_span("get_weather") as tool_span:
            city = "London" if "london" in message.lower() else "Amsterdam"
            tool_span.set_attribute("tool.name", "get_weather")
            tool_span.set_attribute("tool.arguments", json.dumps({"city": city}))
            weather = _get_weather(city)
            tool_span.set_attribute("tool.result", weather)

    # Final text only: the tool call above is never mentioned to the caller.
    return web.json_response({"response": weather})


@pytest_asyncio.fixture
async def test_server():
    """Start the fake remote agent server and shut it down after the test."""
    global base_url

    app = web.Application()
    app.router.add_post("/chat", chat_handler)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "localhost", 0)
    await site.start()

    server = site._server
    assert server is not None
    port = server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    base_url = f"http://localhost:{port}"

    yield

    await runner.cleanup()


@pytest.mark.flaky(reruns=2)
@pytest.mark.asyncio
async def test_remote_trace_propagation(test_server):
    """
    Judge a remote HTTP agent on its traces, not on its words.

    This test verifies:
    - The adapter forwards propagation headers to the remote agent
    - The server's spans join the scenario turn's trace
    - With fetch_remote_traces enabled, the judge sees the get_weather tool
      span even though the response text never mentions it
    """
    result = await scenario.run(
        name="Remote trace propagation",
        description="User asks for the weather in London",
        agents=[
            RemoteAgentAdapter(),
            scenario.UserSimulatorAgent(model="openai/gpt-5-mini"),
            scenario.JudgeAgent(
                model="openai/gpt-5-mini",
                criteria=[
                    "Agent tells the user the weather in London",
                    "The traces show the agent called the get_weather tool",
                ],
            ),
        ],
        script=[
            scenario.user("What's the weather like in London?"),
            scenario.agent(),
            scenario.judge(),
        ],
        fetch_remote_traces=True,
        trace_wait_timeout=20.0,
        set_id="python-examples",
    )

    assert result.success
