"""Unit tests for the A2A agent adapter. See ``specs/a2a-agent-adapter.feature``."""

from typing import Any, Dict, List

import httpx
import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import scenario
from scenario.a2a_agent import A2AAgent, A2AError, _is_rest_task_not_found
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


TASK_NOT_FOUND_INFO = {
    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
    "reason": "TASK_NOT_FOUND",
    "domain": "a2a-protocol.org",
}


def _expiring_task(req: Dict[str, Any]) -> Dict[str, Any]:
    """Asks for input, then forgets the task: every continuation is task-not-found."""
    if req["message"].get("taskId"):
        return {"error": {"code": -32001, "message": "Task not found", "details": [TASK_NOT_FOUND_INFO]}}
    return _task("TASK_STATE_INPUT_REQUIRED", "need more", req["message"]["contextId"])


@pytest.mark.asyncio
@pytest.mark.parametrize("binding", ["JSONRPC", "HTTP+JSON"])
async def test_task_not_found_drops_the_open_task(binding: str):
    with FakeA2AServer(reply=_expiring_task, binding=binding) as server:
        agent = A2AAgent(card_url=server.card_url)
        assert await agent.call(_input("hi")) == "need more"
        with pytest.raises(A2AError) as raised:
            await agent.call(_input("more"))
        assert raised.value.task_not_found
        await agent.call(_input("again"))
        assert "taskId" not in server.requests[2]["body"].get("params", server.requests[2]["body"])["message"]


@pytest.mark.asyncio
async def test_other_errors_keep_the_open_task():
    calls = {"n": 0}

    def reply(req: Dict[str, Any]) -> Dict[str, Any]:
        calls["n"] += 1
        if calls["n"] == 2:
            return {"error": {"code": -32603, "message": "Internal error"}}
        return _task("TASK_STATE_INPUT_REQUIRED", "need more", req["message"]["contextId"])

    with FakeA2AServer(reply=reply) as server:
        agent = A2AAgent(card_url=server.card_url)
        await agent.call(_input("hi"))
        with pytest.raises(A2AError, match="-32603"):
            await agent.call(_input("more"))
        await agent.call(_input("retry"))
        assert server.requests[2]["body"]["params"]["message"]["taskId"] == "task-1"


@pytest.mark.asyncio
async def test_plain_http_404_keeps_the_open_task():
    calls = {"n": 0}

    def reply(req: Dict[str, Any]) -> Dict[str, Any]:
        calls["n"] += 1
        if calls["n"] == 2:
            return {"error": {"code": 404, "message": "Not Found"}}
        return _task("TASK_STATE_INPUT_REQUIRED", "need more", req["message"]["contextId"])

    with FakeA2AServer(reply=reply, binding="HTTP+JSON") as server:
        agent = A2AAgent(card_url=server.card_url)
        await agent.call(_input("hi"))
        with pytest.raises(Exception) as raised:
            await agent.call(_input("more"))
        assert not getattr(raised.value, "task_not_found", False)
        await agent.call(_input("retry"))
        assert server.requests[2]["body"]["message"]["taskId"] == "task-1"


@pytest.mark.parametrize(
    "body", [{"error": "Not Found"}, [{"error": {}}], {"error": {"details": 5}}, "Not Found"]
)
def test_unexpected_404_body_is_not_task_not_found(body: Any):
    request = httpx.Request("POST", "http://agent/message:send")
    assert not _is_rest_task_not_found(httpx.Response(404, json=body, request=request))


@pytest.mark.asyncio
@pytest.mark.parametrize("error", ["Not Found", {"details": 5}])
async def test_unexpected_404_body_raises_the_http_status_error(error: Any):
    calls = {"n": 0}

    def reply(req: Dict[str, Any]) -> Dict[str, Any]:
        calls["n"] += 1
        if calls["n"] == 2:
            return {"error": error}
        return _task("TASK_STATE_INPUT_REQUIRED", "need more", req["message"]["contextId"])

    with FakeA2AServer(reply=reply, binding="HTTP+JSON") as server:
        agent = A2AAgent(card_url=server.card_url)
        await agent.call(_input("hi"))
        with pytest.raises(A2AError, match="HTTP 404") as raised:
            await agent.call(_input("more"))
        assert not raised.value.task_not_found


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


def _v1_card(url: str, binding: str = "JSONRPC") -> Dict[str, Any]:
    return {
        "name": "Other Host Agent",
        "supportedInterfaces": [{"url": url, "protocolBinding": binding, "protocolVersion": "1.0"}],
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "card",
    [
        {"name": "old", "protocolVersion": "0.3.0", "url": "http://x/", "preferredTransport": "JSONRPC"},
        {"name": "old", "url": "http://x/", "preferredTransport": "HTTP+JSON"},
    ],
)
async def test_refuses_a_v0_3_card_and_names_the_version(card: Dict[str, Any]):
    with FakeA2AServer(card=card) as server:
        with pytest.raises(A2AError, match="v1.0 only"):
            await A2AAgent(card_url=server.card_url).call(_input("hi"))
        assert server.requests == []


@pytest.mark.asyncio
async def test_skips_v0_interfaces_and_sends_the_tenant():
    with FakeA2AServer(binding="HTTP+JSON", tenant="acme") as server:
        card = server.card()
        card["supportedInterfaces"].insert(
            0, {"url": f"{server.base_url}/old", "protocolBinding": "JSONRPC", "protocolVersion": "0.3"}
        )
        server.card_override = card
        await A2AAgent(card_url=server.card_url).call(_input("hi"))
        assert server.requests[0]["path"] == "/a2a/acme/message:send"
        assert server.requests[0]["body"]["tenant"] == "acme"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "result",
    [
        {"kind": "message", "parts": [{"kind": "text", "text": "REAL ANSWER"}]},
        {},
    ],
)
async def test_a_result_with_neither_task_nor_message_fails(result: Dict[str, Any]):
    with FakeA2AServer(reply=lambda _: result) as server:
        with pytest.raises(A2AError, match="neither a task nor a message"):
            await A2AAgent(card_url=server.card_url).call(_input("hi"))


@pytest.mark.asyncio
@pytest.mark.parametrize("binding", ["JSONRPC", "HTTP+JSON"])
async def test_polls_a_working_task_until_it_completes(binding: str):
    polls: List[Dict[str, Any]] = []

    def get_task(params: Dict[str, Any]) -> Dict[str, Any]:
        polls.append(params)
        state = "TASK_STATE_WORKING" if len(polls) < 2 else "TASK_STATE_COMPLETED"
        return _task(state, "done", "ctx")["task"]

    with FakeA2AServer(
        binding=binding, reply=lambda _: _task("TASK_STATE_WORKING", "", "ctx"), get_task=get_task
    ) as server:
        agent = A2AAgent(card_url=server.card_url, poll_interval=0.01)
        assert await agent.call(_input("hi")) == "done"
        assert [p["id"] for p in polls] == ["task-1", "task-1"]


@pytest.mark.asyncio
async def test_a_task_that_stays_working_fails_after_the_timeout():
    working = lambda _: _task("TASK_STATE_WORKING", "", "ctx")  # noqa: E731
    with FakeA2AServer(reply=working, get_task=lambda _: working(_)["task"]) as server:
        agent = A2AAgent(card_url=server.card_url, poll_interval=0.01, timeout=0.1)
        with pytest.raises(A2AError, match="still working"):
            await agent.call(_input("hi"))


@pytest.mark.asyncio
async def test_auth_stays_on_the_card_origin():
    with FakeA2AServer() as other, FakeA2AServer() as home:
        home.card_override = _v1_card(f"{other.base_url}/a2a")
        await A2AAgent(card_url=home.card_url, auth="SECRET").call(_input("hi"))
        assert home.card_headers[0]["authorization"] == "Bearer SECRET"
        assert "authorization" not in other.requests[0]["headers"]

        opted_in = A2AAgent(card_url=home.card_url, auth="SECRET", send_auth_to_any_host=True)
        await opted_in.call(_input("hi"))
        assert other.requests[1]["headers"]["authorization"] == "Bearer SECRET"


@pytest.mark.asyncio
async def test_a_redirect_is_followed_without_auth_off_the_origin():
    with FakeA2AServer() as target, FakeA2AServer(card_redirect="") as home:
        home.card_redirect = target.card_url
        agent = A2AAgent(card_url=home.card_url, auth={"X-Api-Key": "SECRET"})
        assert await agent.call(_input("hi")) == "echo: hi"
        assert home.card_headers[0]["x-api-key"] == "SECRET"
        assert "x-api-key" not in target.card_headers[0]


@pytest.mark.asyncio
async def test_http_and_body_failures_raise_a2a_error():
    with FakeA2AServer(card_status=500) as server:
        with pytest.raises(A2AError, match="HTTP 500"):
            await A2AAgent(card_url=server.card_url).call(_input("hi"))
    with FakeA2AServer(raw_reply=b"[]") as server:
        with pytest.raises(A2AError, match="not a JSON object"):
            await A2AAgent(card_url=server.card_url).call(_input("hi"))
    with pytest.raises(A2AError, match="failed"):
        await A2AAgent(card_url="http://127.0.0.1:1/.well-known/agent-card.json").call(_input("hi"))


@pytest.mark.asyncio
async def test_a_given_name_is_the_name_before_and_after_the_card():
    with FakeA2AServer() as server:
        agent = A2AAgent(card_url=server.card_url, name="Refund agent")
        assert agent.name == "Refund agent"
        await agent.call(_input("hi"))
        assert agent.name == "Refund agent"


@pytest.mark.asyncio
async def test_a_turn_without_a_new_user_message_fails_instead_of_resending():
    with FakeA2AServer() as server:
        agent = A2AAgent(card_url=server.card_url)
        turn = AgentInput(
            thread_id="t",
            messages=[{"role": "user", "content": "old"}, {"role": "assistant", "content": "reply"}],
            new_messages=[{"role": "assistant", "content": "reply"}],
            scenario_state=None,  # type: ignore[arg-type]
        )
        with pytest.raises(A2AError, match="no new user message"):
            await agent.call(turn)
        assert server.requests == []


@pytest.mark.asyncio
async def test_reuses_an_injected_client():
    sent: List[str] = []

    async def record(request: httpx.Request) -> None:
        sent.append(request.method)

    with FakeA2AServer() as server:
        async with httpx.AsyncClient(event_hooks={"request": [record]}) as client:
            agent = A2AAgent(card_url=server.card_url, client=client)
            await agent.call(_input("one"))
            await agent.call(_input("two"))
            assert not client.is_closed
    assert sent == ["GET", "POST", "POST"]
