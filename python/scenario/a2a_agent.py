"""
An A2A v1.0 agent as the agent under test, built from its Agent Card URL.

The adapter fetches the Agent Card, picks the first v1.0 JSONRPC or HTTP+JSON
interface, and sends each scenario turn as an A2A ``SendMessage`` with one
``contextId`` per scenario thread. Each request carries the W3C trace context
of a client span, so the remote agent's spans join the scenario trace.

See ``specs/a2a-agent-adapter.feature`` and
https://a2a-protocol.org/latest/specification/.
"""

import asyncio
import contextlib
import time
import uuid
from typing import Any, AsyncIterator, Dict, Mapping, Optional, Union
from urllib.parse import quote, urlparse

import httpx
from opentelemetry import propagate, trace
from opentelemetry.trace import SpanKind, Status, StatusCode

from .agent_adapter import AgentAdapter
from .types import AgentInput, AgentReturnTypes, AgentRole

A2A_PROTOCOL_VERSION = "1.0"
SUPPORTED_BINDINGS = ("JSONRPC", "HTTP+JSON")
DONE_STATES = ("completed", "input_required")
PENDING_STATES = ("submitted", "working", "unspecified", "")
MAX_REDIRECTS = 5

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
    """An A2A agent refused or failed a turn, or could not be reached."""

    def __init__(self, message: str, task_not_found: bool = False):
        super().__init__(message)
        self.task_not_found = task_not_found


TASK_NOT_FOUND_CODE = -32001


def _is_rest_task_not_found(response: httpx.Response) -> bool:
    """An HTTP+JSON 404 means task-not-found only when its ErrorInfo says so."""
    try:
        body = response.json()
    except ValueError:
        return False
    error = body.get("error") if isinstance(body, dict) else None
    details = error.get("details") if isinstance(error, dict) else None
    return isinstance(details, list) and any(
        isinstance(detail, dict)
        and detail.get("reason") == "TASK_NOT_FOUND"
        and detail.get("domain") == "a2a-protocol.org"
        for detail in details
    )


def _json_object(response: httpx.Response, what: str) -> Dict[str, Any]:
    try:
        body = response.json()
    except ValueError as error:
        raise A2AError(f"{what} is not JSON: {error}") from error
    if not isinstance(body, dict):
        raise A2AError(f"{what} is not a JSON object (got {type(body).__name__})")
    return body


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _task_state(task: Mapping[str, Any]) -> str:
    """The task state as a short lowercase name: ``completed``, ``input_required``."""
    state = str(_mapping(task.get("status")).get("state") or "")
    return state.removeprefix("TASK_STATE_").lower().replace("-", "_")


def _parts_text(message: Any) -> str:
    parts = _mapping(message).get("parts")
    if not isinstance(parts, list):
        return ""
    return "\n".join(
        p["text"] for p in parts if isinstance(p, Mapping) and isinstance(p.get("text"), str)
    )


def _task_text(task: Mapping[str, Any]) -> str:
    artifacts = task.get("artifacts")
    texts = [_parts_text(a) for a in artifacts] if isinstance(artifacts, list) else []
    texts.append(_parts_text(_mapping(task.get("status")).get("message")))
    return "\n".join(t for t in texts if t)


def _new_user_text(input: AgentInput) -> str:
    """The last user message among the new messages; old turns are never resent."""
    for message in reversed(input.new_messages or []):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join(
                str(p.get("text", "")) for p in content if isinstance(p, Mapping)
            )
    raise A2AError(
        "A2AAgent sends one user message per turn, and this turn has no new user "
        "message. Put a user turn between two agent turns in the script."
    )


def _is_v0(version: Any) -> bool:
    return str(version or "").startswith("0.")


class A2AAgent(AgentAdapter):
    """Runs an A2A v1.0 agent as the agent under test, from its Agent Card URL.

    Args:
        card_url: URL of the Agent Card, usually
            ``https://host/.well-known/agent-card.json``.
        auth: A bearer token, or a mapping of headers sent on the card fetch
            and on every request to the card's origin.
        name: The agent name for the run. Defaults to the card name, which is
            only known after the first turn.
        timeout: Seconds to wait for each HTTP request, and for a task to leave
            the submitted or working state.
        send_auth_to_any_host: Also send ``auth`` to interfaces and redirects on
            other origins than the card's.
        client: An ``httpx.AsyncClient`` to reuse. Defaults to one per turn.
        poll_interval: Seconds between ``GetTask`` polls of an unfinished task.

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
        name: Optional[str] = None,
        timeout: float = 120.0,
        send_auth_to_any_host: bool = False,
        client: Optional[httpx.AsyncClient] = None,
        poll_interval: float = 1.0,
    ):
        self.card_url = card_url
        self.timeout = timeout
        self.send_auth_to_any_host = send_auth_to_any_host
        self.poll_interval = poll_interval
        self._client = client
        self._fixed_name = name
        self.name = name or "A2AAgent"
        if isinstance(auth, str):
            self._auth_headers: Dict[str, str] = {"Authorization": f"Bearer {auth}"}
        else:
            self._auth_headers = dict(auth or {})
        self.card: Optional[Dict[str, Any]] = None
        self._contexts: Dict[str, str] = {}
        self._open_tasks: Dict[str, str] = {}

    @contextlib.asynccontextmanager
    async def _http(self) -> AsyncIterator[httpx.AsyncClient]:
        if self._client is not None:
            yield self._client
            return
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            yield client

    def _may_send_auth(self, url: str) -> bool:
        """Auth goes to the card's origin, or to its https upgrade, unless opted out."""
        if self.send_auth_to_any_host:
            return True
        card, target = httpx.URL(self.card_url), httpx.URL(url)
        if card.host != target.host:
            return False
        if card.scheme == target.scheme:
            return card.port == target.port
        return card.scheme == "http" and target.scheme == "https"

    async def _request(
        self,
        client: httpx.AsyncClient,
        method: str,
        url: str,
        headers: Optional[Dict[str, str]] = None,
        json: Any = None,
    ) -> httpx.Response:
        """Follows up to five redirects, sending auth only where it may go."""
        for _ in range(MAX_REDIRECTS + 1):
            auth = self._auth_headers if self._may_send_auth(url) else {}
            try:
                response = await client.request(
                    method,
                    url,
                    headers={**auth, **(headers or {})},
                    json=json,
                    timeout=self.timeout,
                    follow_redirects=False,
                )
            except httpx.HTTPError as error:
                raise A2AError(f"A2A request to {url} failed: {error!r}") from error
            location = response.headers.get("location")
            if not (response.is_redirect and location):
                return response
            url = str(response.url.join(location))
        raise A2AError(f"A2A request redirected more than {MAX_REDIRECTS} times")

    async def _load_card(self, client: httpx.AsyncClient) -> Dict[str, Any]:
        if self.card is None:
            response = await self._request(client, "GET", self.card_url)
            if not response.is_success:
                raise A2AError(f"Agent Card fetch failed with HTTP {response.status_code}")
            card = _json_object(response, f"The Agent Card at {self.card_url}")
            self.card = card
            if not self._fixed_name:
                self.name = str(card.get("name") or "A2AAgent")
        return self.card

    def _interface(self, card: Mapping[str, Any]) -> Dict[str, Any]:
        interfaces = card.get("supportedInterfaces")
        if not isinstance(interfaces, list) or not interfaces:
            if _is_v0(card.get("protocolVersion")) or card.get("preferredTransport"):
                raise A2AError(
                    f"The Agent Card at {self.card_url} is an A2A "
                    f"v{card.get('protocolVersion') or '0.3'} card; A2AAgent speaks A2A v1.0 only."
                )
            raise A2AError(f"The Agent Card at {self.card_url} lists no supportedInterfaces.")
        found = []
        for interface in interfaces:
            if not isinstance(interface, Mapping) or not isinstance(interface.get("url"), str):
                continue
            binding, version = interface.get("protocolBinding"), interface.get("protocolVersion")
            found.append(f"{binding} {version}" if version else str(binding))
            if binding in SUPPORTED_BINDINGS and not _is_v0(version):
                return dict(interface)
        raise A2AError(
            f"The Agent Card at {self.card_url} lists no supported interface "
            f"(found {found}); A2AAgent supports {list(SUPPORTED_BINDINGS)} on A2A v1.0."
        )

    def _rest_base(self, interface: Mapping[str, Any]) -> str:
        base = str(interface["url"]).rstrip("/")
        tenant = interface.get("tenant")
        return f"{base}/{quote(str(tenant), safe='')}" if tenant else base

    async def _call_method(
        self,
        client: httpx.AsyncClient,
        interface: Mapping[str, Any],
        method: str,
        params: Dict[str, Any],
        headers: Dict[str, str],
    ) -> Dict[str, Any]:
        if interface.get("tenant"):
            params = {**params, "tenant": interface["tenant"]}
        if interface["protocolBinding"] == "HTTP+JSON":
            base = self._rest_base(interface)
            if method == "GetTask":
                task_id = quote(str(params["id"]), safe="")
                response = await self._request(client, "GET", f"{base}/tasks/{task_id}", headers)
            else:
                response = await self._request(
                    client, "POST", f"{base}/message:send", headers, json=params
                )
            task_id = params.get("id") or _mapping(params.get("message")).get("taskId")
            if response.status_code == 404 and task_id and _is_rest_task_not_found(response):
                raise A2AError(f"A2A task {task_id} was not found", task_not_found=True)
            if not response.is_success:
                raise A2AError(f"A2A agent answered HTTP {response.status_code}")
            return _json_object(response, f"The {method} response")
        body = {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": method, "params": params}
        response = await self._request(client, "POST", str(interface["url"]), headers, json=body)
        if not response.is_success:
            raise A2AError(f"A2A agent answered HTTP {response.status_code}")
        payload = _json_object(response, f"The {method} response")
        if "error" in payload:
            error = _mapping(payload["error"])
            raise A2AError(
                f"A2A agent returned JSON-RPC error {error.get('code')}: {error.get('message')}",
                task_not_found=error.get("code") == TASK_NOT_FOUND_CODE,
            )
        result = payload.get("result")
        if not isinstance(result, dict):
            raise A2AError(f"The {method} result is not a JSON object")
        return result

    async def _wait_for_task(
        self,
        client: httpx.AsyncClient,
        interface: Mapping[str, Any],
        task: Dict[str, Any],
        headers: Dict[str, str],
    ) -> Dict[str, Any]:
        """Polls ``GetTask`` while the task is submitted or working."""
        deadline = time.monotonic() + self.timeout
        while _task_state(task) in PENDING_STATES:
            if not task.get("id"):
                raise A2AError(f"A2A task in state {_task_state(task) or 'unspecified'} has no id to poll")
            if time.monotonic() >= deadline:
                raise A2AError(
                    f"A2A task {task['id']} is still {_task_state(task) or 'unspecified'} "
                    f"after {self.timeout}s"
                )
            await asyncio.sleep(self.poll_interval)
            task = await self._call_method(client, interface, "GetTask", {"id": task["id"]}, headers)
        return task

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        text = _new_user_text(input)
        async with self._http() as client:
            card = await self._load_card(client)
            interface = self._interface(card)
            context_id = self._contexts.setdefault(input.thread_id, str(uuid.uuid4()))
            message: Dict[str, Any] = {
                "messageId": str(uuid.uuid4()),
                "contextId": context_id,
                "role": "ROLE_USER",
                "parts": [{"text": text}],
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
                        "server.address": urlparse(str(interface["url"])).hostname or "",
                    }
                )
                headers = {"A2A-Version": A2A_PROTOCOL_VERSION}
                propagate.inject(headers)
                try:
                    result = await self._call_method(
                        client, interface, "SendMessage", {"message": message}, headers
                    )
                except A2AError as error:
                    if error.task_not_found:
                        self._open_tasks.pop(input.thread_id, None)
                    raise
                self._open_tasks.pop(input.thread_id, None)

                task, reply = result.get("task"), result.get("message")
                if isinstance(reply, Mapping):
                    if reply.get("contextId"):
                        self._contexts[input.thread_id] = str(reply["contextId"])
                    return _parts_text(reply)
                if not isinstance(task, dict):
                    shape = " It looks like an A2A v0.3 result." if "kind" in result else ""
                    raise A2AError(
                        f"The SendMessage result has neither a task nor a message "
                        f"(keys {sorted(result)}).{shape}"
                    )
                task = await self._wait_for_task(client, interface, task, headers)
                state = _task_state(task)
                span.set_attribute(ATTR_TASK_ID, str(task.get("id", "")))
                span.set_attribute(ATTR_TASK_STATE, state)
                if task.get("contextId"):
                    self._contexts[input.thread_id] = str(task["contextId"])
                if state not in DONE_STATES:
                    error = A2AError(
                        f"A2A task {task.get('id')} ended in state {state}: "
                        f"{_parts_text(_mapping(task.get('status')).get('message'))}"
                    )
                    span.set_status(Status(StatusCode.ERROR, str(error)))
                    raise error
                if state == "input_required" and task.get("id"):
                    self._open_tasks[input.thread_id] = str(task["id"])
                return _task_text(task)
