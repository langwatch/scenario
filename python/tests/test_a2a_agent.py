"""Unit tests for the A2A agent adapter. See ``specs/a2a-agent-adapter.feature``."""

from typing import Any, Dict, List

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import scenario
from scenario.a2a_agent import A2AAgent, A2AError
from scenario.types import AgentInput

from tests.helpers.fake_a2a_server import FakeA2AServer, text_message

_exporter = InMemorySpanExporter()
_provider = TracerProvider()
_provider.add_span_processor(SimpleSpanProcessor(_exporter))
_tracer = _provider.get_tracer("test.a2a")


def _input(text: str, thread_id: str = "thread-1") -> AgentInput:
    messages: List[Any] = [{"role": "user", "content": text}]
    return AgentInput(
        thread_id=thread_id,
        messages=messages,
        new_messages=messages,
        scenario_state=None,  # type: ignore[arg-type]
    )


def _task(state: str, text: str, context_id: str) -> Dict[str, Any]:
    return {
        "task": {
            "id": "task-1",
            "contextId": context_id,
            "status": {"state": state, "message": {"role": "ROLE_AGENT", "parts": [{"text": text}]}},
        }
    }


def test_exports_from_the_package():
    assert scenario.A2AAgent is A2AAgent


@pytest.mark.asyncio
async def test_reads_the_card_once_and_takes_its_name():
    with FakeA2AServer() as server:
        agent = A2AAgent(card_url=server.card_url)
        assert await agent.call(_input("hi")) == "echo: hi"
        assert await agent.call(_input("again")) == "echo: again"
        assert len(server.card_headers) == 1
        assert agent.name == "Fake A2A Agent"
        assert server.requests[0]["path"] == "/a2a"
        assert server.requests[0]["body"]["method"] == "SendMessage"


@pytest.mark.asyncio
async def test_refuses_a_card_with_only_grpc():
    with FakeA2AServer(binding="GRPC") as server:
        with pytest.raises(A2AError, match="JSONRPC"):
            await A2AAgent(card_url=server.card_url).call(_input("hi"))


@pytest.mark.asyncio
async def test_one_context_id_per_thread():
    with FakeA2AServer() as server:
        agent = A2AAgent(card_url=server.card_url)
        await agent.call(_input("one"))
        await agent.call(_input("two"))
        await agent.call(_input("other", thread_id="thread-2"))
        messages = [r["body"]["params"]["message"] for r in server.requests]
        assert messages[0]["parts"] == [{"text": "one"}]
        assert messages[0]["role"] == "ROLE_USER"
        assert messages[0]["contextId"] == messages[1]["contextId"]
        assert messages[2]["contextId"] != messages[0]["contextId"]


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["TASK_STATE_COMPLETED", "TASK_STATE_INPUT_REQUIRED"])
async def test_reads_the_text_of_a_task(state: str):
    reply = lambda req: _task(state, "done", req["message"]["contextId"])  # noqa: E731
    with FakeA2AServer(reply=reply) as server:
        agent = A2AAgent(card_url=server.card_url)
        assert await agent.call(_input("hi")) == "done"
        if state == "TASK_STATE_INPUT_REQUIRED":
            await agent.call(_input("more"))
            assert server.requests[1]["body"]["params"]["message"]["taskId"] == "task-1"


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["TASK_STATE_FAILED", "TASK_STATE_REJECTED"])
async def test_failed_task_fails_the_turn(state: str):
    reply = lambda req: _task(state, "no can do", req["message"]["contextId"])  # noqa: E731
    with FakeA2AServer(reply=reply) as server:
        with pytest.raises(A2AError, match="no can do"):
            await A2AAgent(card_url=server.card_url).call(_input("hi"))


@pytest.mark.asyncio
async def test_jsonrpc_error_fails_the_turn():
    error = {"code": -32602, "message": "Invalid parameters"}
    with FakeA2AServer(jsonrpc_error=error) as server:
        with pytest.raises(A2AError, match="-32602: Invalid parameters"):
            await A2AAgent(card_url=server.card_url).call(_input("hi"))


@pytest.mark.asyncio
async def test_http_json_binding_posts_to_message_send():
    reply = lambda req: text_message("rest", req["message"]["contextId"])  # noqa: E731
    with FakeA2AServer(reply=reply, binding="HTTP+JSON") as server:
        assert await A2AAgent(card_url=server.card_url).call(_input("hi")) == "rest"
        assert server.requests[0]["path"] == "/a2a/message:send"


@pytest.mark.asyncio
async def test_request_carries_the_scenario_trace_context(monkeypatch):
    monkeypatch.setattr("scenario.a2a_agent._tracer", _tracer)
    with FakeA2AServer() as server:
        with _tracer.start_as_current_span("scenario turn") as parent:
            await A2AAgent(card_url=server.card_url).call(_input("hi"))
        trace_id = format(parent.get_span_context().trace_id, "032x")
        headers = server.requests[0]["headers"]
        assert headers["traceparent"].split("-")[1] == trace_id
        assert headers["a2a-version"] == "1.0"
        client = next(s for s in _exporter.get_finished_spans() if s.name.startswith("invoke_agent"))
        attributes = dict(client.attributes or {})
        assert attributes["gen_ai.agent.name"] == "Fake A2A Agent"
        assert attributes["a2a.method"] == "SendMessage"
        assert attributes["a2a.protocol.binding"] == "JSONRPC"
        assert attributes["a2a.context.id"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "auth,expected",
    [("tok", ("authorization", "Bearer tok")), ({"X-Api-Key": "k"}, ("x-api-key", "k"))],
)
async def test_auth_reaches_card_and_requests(auth: Any, expected: Any):
    with FakeA2AServer() as server:
        await A2AAgent(card_url=server.card_url, auth=auth).call(_input("hi"))
        card_headers = {k.lower(): v for k, v in server.card_headers[0].items()}
        assert card_headers[expected[0]] == expected[1]
        assert server.requests[0]["headers"][expected[0]] == expected[1]
