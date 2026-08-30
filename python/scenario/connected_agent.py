"""
A connected agent function as a scenario agent.

``langwatch.connect_agent`` returns an object that is still the original
function, and that also answers ``invoke(call)`` with the turn fields of the
connected agent contract: ``messages``, ``new_messages``, ``thread_id``,
``session``, ``trace_id`` and the run ``parameters``. This module wraps such
an object into an :class:`AgentAdapter`, so ``scenario.run(agents=[...])``
accepts it directly and the local test and the platform run share one piece
of code for the agent.

The accept is duck typed. Nothing here imports the LangWatch SDK: any callable
with a ``name`` and an awaitable ``invoke`` is a connected agent.

See ``specs/connected-agent-adapter.feature``.
"""

from dataclasses import dataclass, field
from typing import (
    Any,
    Awaitable,
    Dict,
    List,
    Mapping,
    Optional,
    Protocol,
    Sequence,
    Tuple,
    TypeGuard,
    Union,
    cast,
    runtime_checkable,
)

from .agent_adapter import AgentAdapter
from .types import AgentInput, AgentReturnTypes, AgentRole


@dataclass
class ConnectedAgentCall:
    """One turn as the connected agent contract sends it.

    The attribute names match the ``AgentCall`` of the LangWatch SDK, so the
    decorated function reads the same fields locally and on the platform.
    """

    messages: List[Any]
    new_messages: List[Any] = field(default_factory=list)
    thread_id: str = ""
    session: Any = None
    trace_id: Optional[str] = None
    parameters: Dict[str, Any] = field(default_factory=dict)

    def turn_fields(self) -> Dict[str, Any]:
        return {
            "messages": self.messages,
            "new_messages": self.new_messages,
            "thread_id": self.thread_id,
            "session": self.session,
            "trace_id": self.trace_id,
        }


@runtime_checkable
class ConnectedAgentLike(Protocol):
    """The shape ``langwatch.connect_agent`` returns.

    ``invoke`` receives a :class:`ConnectedAgentCall` and returns the reply:
    a string, one message, a list of messages, or an object with ``output``
    and ``session``.
    """

    name: str

    def __call__(self, *args: Any, **kwargs: Any) -> Any: ...

    def invoke(self, call: Any) -> Awaitable[Any]: ...


AgentLike = Union[AgentAdapter, ConnectedAgentLike]


def is_connected_agent(value: Any) -> TypeGuard[ConnectedAgentLike]:
    """True for a callable with a string ``name`` and a callable ``invoke``."""
    return (
        not isinstance(value, AgentAdapter)
        and callable(value)
        and isinstance(getattr(value, "name", None), str)
        and callable(getattr(value, "invoke", None))
    )


def trace_id_from_headers(headers: Mapping[str, str]) -> Optional[str]:
    """The trace id of a W3C ``traceparent`` header, or None."""
    traceparent = headers.get("traceparent")
    if not isinstance(traceparent, str):
        return None
    parts = traceparent.split("-")
    if len(parts) >= 3 and len(parts[1]) == 32:
        return parts[1]
    return None


def read_reply(reply: Any) -> Tuple[AgentReturnTypes, Any]:
    """The output and the session of one reply.

    Accepts a string, one message, a list of messages, a mapping with an
    ``output`` key, or an object with an ``output`` attribute (the SDK's
    ``AgentReply``). The session is None when the reply carries none.
    """
    session: Any = None
    output: Any = reply
    if isinstance(reply, Mapping) and "output" in reply:
        output = reply["output"]
        session = reply.get("session")
    elif not isinstance(reply, (str, list, tuple, Mapping)) and hasattr(
        reply, "output"
    ):
        output = getattr(reply, "output")
        session = getattr(reply, "session", None)

    if output is None:
        output = ""
    elif isinstance(output, tuple):
        output = list(output)
    elif not isinstance(output, (str, list, Mapping)):
        output = str(output)
    return cast(AgentReturnTypes, output), session


class ConnectedAgentAdapter(AgentAdapter):
    """Runs a connected agent function as the agent under test.

    Builds the connected call from the scenario's :class:`AgentInput`, keeps
    the ``session`` the function returns per thread, and sends it back on the
    next turn of the same thread, the same echo the platform does.

    Args:
        agent: The decorated function.
        parameters: The run parameters for every call. A parameter that is
            not set here takes the default the function declares.
    """

    role = AgentRole.AGENT

    def __init__(
        self,
        agent: ConnectedAgentLike,
        parameters: Optional[Mapping[str, Any]] = None,
    ) -> None:
        if not is_connected_agent(agent):
            raise TypeError(
                "ConnectedAgentAdapter expects the object langwatch.connect_agent "
                "returns: a callable with a name and an invoke method"
            )
        self.agent = agent
        self.name = agent.name
        self.parameters: Dict[str, Any] = dict(parameters or {})
        self._sessions: Dict[str, Any] = {}

    def session_for(self, thread_id: str) -> Any:
        """The session held for a thread, None before the first reply."""
        return self._sessions.get(thread_id)

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        call = ConnectedAgentCall(
            messages=list(input.messages),
            new_messages=list(input.new_messages),
            thread_id=input.thread_id,
            session=self._sessions.get(input.thread_id),
            trace_id=trace_id_from_headers(input.propagation_headers),
            parameters=dict(self.parameters),
        )
        reply = await self.agent.invoke(call)
        output, session = read_reply(reply)
        if session is not None:
            self._sessions[input.thread_id] = session
        return output


def resolve_agents(
    agents: Sequence[AgentLike],
    parameters: Optional[Mapping[str, Any]] = None,
) -> List[AgentAdapter]:
    """Every connected agent function wrapped, every adapter as is."""
    return [
        ConnectedAgentAdapter(agent, parameters)
        if is_connected_agent(agent)
        else cast(AgentAdapter, agent)
        for agent in agents
    ]
