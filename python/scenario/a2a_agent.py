"""
An A2A agent as the agent under test, built from its Agent Card URL.

The adapter fetches the Agent Card, picks the first JSONRPC or HTTP+JSON
interface, and sends each scenario turn as an A2A ``SendMessage`` with one
``contextId`` per scenario thread. Each request carries the W3C trace context
of a client span, so the remote agent's spans join the scenario trace.

See ``specs/a2a-agent-adapter.feature`` and
https://a2a-protocol.org/latest/specification/.
"""

import uuid
from typing import Any, Dict, Mapping, Optional, Union
from urllib.parse import urlparse

import httpx
from opentelemetry import propagate, trace
from opentelemetry.trace import SpanKind, Status, StatusCode

from .agent_adapter import AgentAdapter
from .types import AgentInput, AgentReturnTypes, AgentRole

A2A_PROTOCOL_VERSION = "1.0"
SUPPORTED_BINDINGS = ("JSONRPC", "HTTP+JSON")
FAILED_STATES = ("failed", "rejected", "canceled", "auth_required")

# The a2a.* names follow the proposal in
# open-telemetry/semantic-conventions-genai#254 and are not stable yet.
ATTR_AGENT_NAME = "gen_ai.agent.name"
ATTR_OPERATION = "gen_ai.operation.name"
ATTR_BINDING = "a2a.protocol.binding"
ATTR_VERSION = "a2a.protocol.version"
ATTR_METHOD = "a2a.method"
ATTR_CONTEXT_ID = "a2a.context.id"
ATTR_TASK_ID = "a2a.task.id"
ATTR_TASK_STATE = "a2a.task.state"
ATTR_MESSAGE_ID = "a2a.message.id"

_tracer = trace.get_tracer("scenario.a2a")


class A2AError(Exception):
    """An A2A agent refused or failed a turn."""


def _task_state(task: Mapping[str, Any]) -> str:
    """The task state as a short lowercase name: ``completed``, ``input_required``."""
    state = str((task.get("status") or {}).get("state") or "")
    return state.removeprefix("TASK_STATE_").lower().replace("-", "_")


def _parts_text(message: Optional[Mapping[str, Any]]) -> str:
    parts = (message or {}).get("parts") or []
    return "\n".join(p["text"] for p in parts if isinstance(p.get("text"), str))


def _reply_text(result: Mapping[str, Any]) -> str:
    """The text of a ``SendMessage`` result: a message, or a task's status and artifacts."""
    if "message" in result:
        return _parts_text(result["message"])
    task = result.get("task") or {}
    texts = [_parts_text(a) for a in task.get("artifacts") or []]
    texts.append(_parts_text((task.get("status") or {}).get("message")))
    return "\n".join(t for t in texts if t)


def _last_user_text(input: AgentInput) -> str:
    for message in reversed(input.new_messages or input.messages):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join(
                str(p.get("text", "")) for p in content if isinstance(p, Mapping)
            )
    return ""


class A2AAgent(AgentAdapter):
    """Runs any A2A agent as the agent under test, from its Agent Card URL.

    Args:
        card_url: URL of the Agent Card, usually
            ``https://host/.well-known/agent-card.json``.
        auth: A bearer token, or a mapping of headers sent on the card fetch
            and on every request.
        timeout: Seconds to wait for each HTTP request.

    Example:
        ```python
        result = await scenario.run(
            name="refund request",
            description="A customer asks for a refund",
            agents=[
                scenario.A2AAgent(card_url="http://localhost:9999/.well-known/agent-card.json"),
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent(criteria=["The agent explains the refund policy"]),
            ],
        )
        ```
    """

    role = AgentRole.AGENT

    def __init__(
        self,
        card_url: str,
        auth: Union[str, Mapping[str, str], None] = None,
        timeout: float = 120.0,
    ):
        self.card_url = card_url
        self.timeout = timeout
        if isinstance(auth, str):
            self._auth_headers: Dict[str, str] = {"Authorization": f"Bearer {auth}"}
        else:
            self._auth_headers = dict(auth or {})
        self.card: Optional[Dict[str, Any]] = None
        self._contexts: Dict[str, str] = {}
        self._open_tasks: Dict[str, str] = {}

    async def _load_card(self, client: httpx.AsyncClient) -> Dict[str, Any]:
        if self.card is None:
            response = await client.get(self.card_url, headers=self._auth_headers)
            response.raise_for_status()
            card: Dict[str, Any] = response.json()
            self.card = card
            self.name = str(card.get("name") or "A2AAgent")
        return self.card

    def _interface(self, card: Mapping[str, Any]) -> Dict[str, str]:
        interfaces = list(card.get("supportedInterfaces") or [])
        if not interfaces and card.get("url"):
            interfaces = [{"url": card["url"], "protocolBinding": "JSONRPC"}]
        for interface in interfaces:
            if interface.get("protocolBinding") in SUPPORTED_BINDINGS:
                return interface
        found = [i.get("protocolBinding") for i in interfaces]
        raise A2AError(
            f"The Agent Card at {self.card_url} lists no supported interface "
            f"(found {found}); A2AAgent supports {list(SUPPORTED_BINDINGS)}."
        )

    async def _post(
        self,
        client: httpx.AsyncClient,
        interface: Mapping[str, str],
        request: Dict[str, Any],
        headers: Dict[str, str],
    ) -> Dict[str, Any]:
        url = interface["url"]
        if interface["protocolBinding"] == "HTTP+JSON":
            response = await client.post(
                url.rstrip("/") + "/message:send", json=request, headers=headers
            )
            response.raise_for_status()
            return response.json()
        body = {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": "SendMessage"}
        response = await client.post(url, json={**body, "params": request}, headers=headers)
        response.raise_for_status()
        payload = response.json()
        if "error" in payload:
            error = payload["error"] or {}
            raise A2AError(
                f"A2A agent returned JSON-RPC error {error.get('code')}: {error.get('message')}"
            )
        return payload.get("result") or {}

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            card = await self._load_card(client)
            interface = self._interface(card)
            context_id = self._contexts.setdefault(input.thread_id, str(uuid.uuid4()))
            message: Dict[str, Any] = {
                "messageId": str(uuid.uuid4()),
                "contextId": context_id,
                "role": "ROLE_USER",
                "parts": [{"text": _last_user_text(input)}],
            }
            if input.thread_id in self._open_tasks:
                message["taskId"] = self._open_tasks[input.thread_id]

            with _tracer.start_as_current_span(
                f"invoke_agent {self.name}", kind=SpanKind.CLIENT
            ) as span:
                span.set_attributes(
                    {
                        ATTR_OPERATION: "invoke_agent",
                        ATTR_AGENT_NAME: str(self.name),
                        ATTR_BINDING: str(interface["protocolBinding"]),
                        ATTR_VERSION: A2A_PROTOCOL_VERSION,
                        ATTR_METHOD: "SendMessage",
                        ATTR_CONTEXT_ID: context_id,
                        ATTR_MESSAGE_ID: message["messageId"],
                        "server.address": urlparse(interface["url"]).hostname or "",
                    }
                )
                headers = {
                    **self._auth_headers,
                    "A2A-Version": A2A_PROTOCOL_VERSION,
                }
                propagate.inject(headers)
                result = await self._post(client, interface, {"message": message}, headers)
                self._open_tasks.pop(input.thread_id, None)

                task = result.get("task")
                if isinstance(task, Mapping):
                    state = _task_state(task)
                    span.set_attribute(ATTR_TASK_ID, str(task.get("id", "")))
                    span.set_attribute(ATTR_TASK_STATE, state)
                    if task.get("contextId"):
                        self._contexts[input.thread_id] = str(task["contextId"])
                    if state in FAILED_STATES:
                        error = A2AError(
                            f"A2A task {task.get('id')} ended in state {state}: "
                            f"{_parts_text((task.get('status') or {}).get('message'))}"
                        )
                        span.set_status(Status(StatusCode.ERROR, str(error)))
                        raise error
                    if state == "input_required" and task.get("id"):
                        self._open_tasks[input.thread_id] = str(task["id"])
                elif isinstance(result.get("message"), Mapping):
                    reply_context = result["message"].get("contextId")
                    if reply_context:
                        self._contexts[input.thread_id] = str(reply_context)
                return _reply_text(result)

