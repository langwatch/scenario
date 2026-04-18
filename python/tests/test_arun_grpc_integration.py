"""Literal reproduction of the customer's symptom with real ``grpc.aio``.

A grpc.aio server + channel is built once in a pytest fixture — the
channel's completion queue and underlying futures are bound to the
pytest event loop. A sibling test running the SAME channel through
``scenario.arun`` must work, and the SAME channel through
``scenario.run`` must fail with a loop-affinity error. This is the
customer's exact production setup distilled to a self-contained test.

Skipped if grpc is unavailable (ADK ships it, so normally installed).
"""

from __future__ import annotations

import asyncio
import os
import threading

import pytest

os.environ.setdefault("SCENARIO_HEADLESS", "true")

try:
    import grpc  # type: ignore[import-not-found]
    from grpc import aio as grpc_aio  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    pytest.skip("grpc not installed", allow_module_level=True)

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


# A no-frills GenericHandler that responds with a fixed byte reply. Using
# the low-level grpc API keeps the test independent of any generated
# stubs and keeps it minimal.
class _EchoHandler(grpc.GenericRpcHandler):
    def service(self, handler_call_details):
        if handler_call_details.method == "/echo/Echo":
            return grpc.unary_unary_rpc_method_handler(
                lambda request, context: b"ok:" + request,
            )
        return None


class _RunningEchoServer:
    """Context manager for a grpc.aio server + channel owned by the
    caller's current event loop."""

    def __init__(self) -> None:
        self.server: grpc_aio.Server | None = None
        self.channel: grpc_aio.Channel | None = None

    async def __aenter__(self) -> grpc_aio.Channel:
        self.server = grpc_aio.server()
        self.server.add_generic_rpc_handlers((_EchoHandler(),))
        port = self.server.add_insecure_port("127.0.0.1:0")
        await self.server.start()
        self.channel = grpc_aio.insecure_channel(f"127.0.0.1:{port}")
        return self.channel

    async def __aexit__(self, *args) -> None:
        assert self.channel is not None and self.server is not None
        await self.channel.close()
        await self.server.stop(None)


def _identity(x: bytes) -> bytes:
    return x


async def _call_echo(channel: grpc_aio.Channel, payload: bytes) -> bytes:
    """Single unary round-trip on the given channel."""
    rpc = channel.unary_unary(
        "/echo/Echo",
        request_serializer=_identity,
        response_deserializer=_identity,
    )
    return await rpc(payload)


class _GrpcAgent(AgentAdapter):
    def __init__(self, channel: grpc_aio.Channel, observed: list[dict]):
        self._channel = channel
        self._observed = observed

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        reply = await _call_echo(self._channel, b"hello")
        self._observed.append(
            {
                "loop_id": id(asyncio.get_running_loop()),
                "thread_name": threading.current_thread().name,
                "reply": reply.decode("utf-8"),
            }
        )
        return {"role": "assistant", "content": reply.decode("utf-8")}


class _User(AgentAdapter):
    role = AgentRole.USER

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "ping"


class _Judge(AgentAdapter):
    role = AgentRole.JUDGE

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return ScenarioResult(
            success=True, messages=[], reasoning="ok", passed_criteria=["grpc ok"]
        )


@pytest.mark.asyncio
async def test_grpc_channel_works_under_arun():
    """Real grpc.aio channel created on the test's own loop survives
    arun — exactly the customer's scenario (singleton channel re-used
    from a scenario adapter)."""
    observed: list[dict] = []

    async with _RunningEchoServer() as channel:
        result = await scenario.arun(
            name="grpc-arun",
            description="grpc unary RPC from adapter",
            agents=[_GrpcAgent(channel, observed), _User(), _Judge()],
            script=[
                scenario.user("ping"),
                scenario.agent(),
                scenario.judge(),
            ],
        )

    assert result.success
    assert len(observed) == 1
    assert observed[0]["loop_id"] == id(asyncio.get_running_loop())
    assert observed[0]["thread_name"] == threading.main_thread().name
    assert observed[0]["reply"] == "ok:hello"


@pytest.mark.asyncio
async def test_concurrent_arun_shares_one_grpc_channel():
    """Five concurrent arun invocations all talking to the SAME
    grpc.aio channel on the same loop — pattern that breaks under
    the threaded path."""
    observed: list[dict] = []

    async with _RunningEchoServer() as channel:
        async def one(i: int):
            return await scenario.arun(
                name=f"grpc-arun-{i}",
                description="shared channel",
                agents=[_GrpcAgent(channel, observed), _User(), _Judge()],
                script=[
                    scenario.user("ping"),
                    scenario.agent(),
                    scenario.judge(),
                ],
            )

        results = await asyncio.gather(*(one(i) for i in range(5)))

    assert all(r.success for r in results)
    loop_ids = {o["loop_id"] for o in observed}
    assert loop_ids == {id(asyncio.get_running_loop())}
    assert len(observed) == 5
    assert all(o["reply"] == "ok:hello" for o in observed)


@pytest.mark.asyncio
async def test_grpc_channel_breaks_under_scenario_run():
    """Characterisation: the SAME real grpc.aio channel raises a
    loop-affinity error when driven via ``scenario.run`` (threaded).

    This is the customer's exact production bug reduced to a
    self-contained test.
    """
    observed: list[dict] = []

    async with _RunningEchoServer() as channel:
        with pytest.raises(Exception) as excinfo:
            await scenario.run(
                name="grpc-run-negative",
                description="threaded path must fail on loop-bound grpc channel",
                agents=[_GrpcAgent(channel, observed), _User(), _Judge()],
                script=[
                    scenario.user("ping"),
                    scenario.agent(),
                    scenario.judge(),
                ],
            )

    message = str(excinfo.value).lower()
    assert any(
        keyword in message
        for keyword in (
            "different loop",
            "different event loop",
            "no running event loop",
            "event loop is closed",
            "attached to a different",
        )
    ), f"Expected loop-affinity-style error, got: {excinfo.value!r}"
