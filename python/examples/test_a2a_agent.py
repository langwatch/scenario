"""
Example: test an A2A agent from nothing but its Agent Card URL.

A small A2A agent runs locally (an Agent Card plus JSON-RPC ``SendMessage``,
backed by a real model). ``scenario.A2AAgent`` reads the card and drives the
conversation; every request carries ``traceparent``, so the server's spans
join the scenario trace of each turn.
"""

import os
from typing import Any, Dict, List

import litellm
import pytest
import pytest_asyncio
from aiohttp import web
from opentelemetry import propagate
from opentelemetry import trace as otel_trace

import scenario

MODEL = os.getenv("SCENARIO_EXAMPLE_MODEL", "openai/gpt-5-mini")
SYSTEM = "You are a support agent for ACME bikes. Refunds are allowed within 30 days of purchase. Be brief."

histories: Dict[str, List[Dict[str, Any]]] = {}
server_spans: List[Dict[str, str]] = []
base_url = ""


async def card_handler(request: web.Request) -> web.Response:
    return web.json_response(
        {
            "name": "ACME Support Agent",
            "description": "Answers questions about ACME bike orders and refunds",
            "version": "1.0.0",
            "supportedInterfaces": [
                {"url": f"{base_url}/a2a", "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}
            ],
            "capabilities": {"streaming": False},
            "defaultInputModes": ["text/plain"],
            "defaultOutputModes": ["text/plain"],
            "skills": [{"id": "refunds", "name": "Refunds", "description": "Refund policy", "tags": []}],
        }
    )


async def a2a_handler(request: web.Request) -> web.Response:
    """JSON-RPC ``SendMessage``: keeps one chat history per ``contextId``."""
    body = await request.json()
    message = body["params"]["message"]
    context_id = message["contextId"]
    history = histories.setdefault(context_id, [{"role": "system", "content": SYSTEM}])
    history.append({"role": "user", "content": message["parts"][0]["text"]})

    tracer = otel_trace.get_tracer("acme-support-agent")
    parent = propagate.extract(dict(request.headers))
    with tracer.start_as_current_span("a2a.server SendMessage", context=parent) as span:
        response = await litellm.acompletion(model=MODEL, messages=history)
        text = response.choices[0].message.content or ""  # type: ignore[union-attr]
        server_spans.append(
            {
                "traceparent": request.headers.get("traceparent", ""),
                "server_trace_id": format(span.get_span_context().trace_id, "032x"),
            }
        )
    history.append({"role": "assistant", "content": text})
    result = {"message": {"messageId": f"m{len(history)}", "contextId": context_id, "role": "ROLE_AGENT", "parts": [{"text": text}]}}
    return web.json_response({"jsonrpc": "2.0", "id": body["id"], "result": result})


@pytest_asyncio.fixture
async def a2a_server():
    global base_url
    app = web.Application()
    app.router.add_get("/.well-known/agent-card.json", card_handler)
    app.router.add_post("/a2a", a2a_handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "localhost", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    base_url = f"http://localhost:{port}"
    yield f"{base_url}/.well-known/agent-card.json"
    await runner.cleanup()


@pytest.mark.flaky(reruns=2)
@pytest.mark.asyncio
async def test_a2a_agent_from_card(a2a_server: str):
    server_spans.clear()
    histories.clear()
    result = await scenario.run(
        name="A2A refund request",
        description="A customer bought a bike two weeks ago and asks for a refund",
        agents=[
            scenario.A2AAgent(card_url=a2a_server),
            scenario.UserSimulatorAgent(model=MODEL),
            scenario.JudgeAgent(model=MODEL, criteria=["The agent says the refund is possible"]),
        ],
        script=[
            scenario.user("Hi, I bought a bike from you two weeks ago. Can I get a refund?"),
            scenario.agent(),
            scenario.user(),
            scenario.agent(),
            scenario.judge(),
        ],
        set_id="python-examples",
    )

    for turn in server_spans:
        print(f"A2A server span: traceparent={turn['traceparent']} server_trace_id={turn['server_trace_id']}")
    assert len(server_spans) == 2
    assert len(histories) == 1 and len(next(iter(histories.values()))) == 5
    for turn in server_spans:
        assert turn["traceparent"].split("-")[1] == turn["server_trace_id"]
    assert result.success, result.reasoning
