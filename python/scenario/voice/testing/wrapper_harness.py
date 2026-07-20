"""
Wrapper-level test harness for voice adapters — the tier-1 seam that drives an
agent turn through the REAL production ``adapter.call()`` wrapper.

WHY wrapper-level (not seam-level) tests are load-bearing: PR #697's P0 hid
because the seam tests drove adapter internals *by name* while production
crashed in the wrapper that wires those internals together. A wrapper-level
test stubs nothing between the test and the adapter's outermost production
entry point, so a fix (or a regression) that only manifests on the real
``call()`` / ``connect()`` flow cannot hide behind a test seam.

This module EXTRACTS the proven Twilio harness from
``tests/voice/test_twilio_silent_stop_drain.py`` — whose module docstring tells
the full two-layer measurement story (the REAL-route anti-drift gate
``TestRealRoute`` plus the wrapper-level tests it proves are equivalent) — and
adds the generic ``drive_call`` / ``make_agent_input`` entry points that
generalise the same tier-1 idea to the non-Twilio adapters.

Vendor transports should be faked at the NETWORK CLIENT boundary (monkeypatched
``websockets.connect`` / ``genai.Client``), never by **substituting a stub
transport** for adapter privates like ``_ws`` or ``_session`` — injecting a
fake transport under the wrapper is the seam that let #697's P0 hide, and is
exactly what this harness exists to avoid.

That ban is on transport *substitution*, not on field assignment as such.
``make_connected_twilio_adapter`` does assign several privates, but it builds
the **real** collaborators into them (a real ``TwilioWebhookServer``, real
queues/events) because the real ``connect()`` would need live Twilio REST
credentials to resolve the phone-number SID. The media-stream path it then
drives is production code end to end. See that function's docstring.

Not imported by default from ``scenario.voice``. Users opt-in via
``from scenario.voice.testing import drive_call, make_agent_input``.
"""

from __future__ import annotations

import asyncio
import socket
from contextlib import asynccontextmanager, suppress
from typing import Any, AsyncIterator, List, Optional, cast

from ...types import AgentInput
from ..adapter import VoiceAgentAdapter
from ..adapters import TwilioAgentAdapter
from ..adapters._twilio_server import TwilioWebhookServer
from ..audio_chunk import AudioChunk
from ..messages import create_audio_message


# ------------------------------------------------------- generic wrapper drive


class _WrapperCallInput:
    """Minimal duck-typed AgentInput for direct production-wrapper `call()` tests.

    Mirrors the established `_FakeInput` seam (tests/voice/test_realtime_tool_calls.py):
    carries no scenario_state, so `_AdapterRecorder` degrades to a no-op; when
    `new_messages` is empty, `call()` sends no user audio and goes straight to
    draining the agent response.

    Private: callers construct it through `make_agent_input`, which hands back an
    `AgentInput`-typed value so the public surface carries a real contract rather
    than leaking `Any`.
    """

    def __init__(self, new_messages: Optional[List[Any]] = None) -> None:
        self.new_messages: List[Any] = list(new_messages or [])


def make_agent_input(user_audio: Optional[AudioChunk] = None) -> AgentInput:
    """Build the minimal input `drive_call` feeds the real `call()`.

    With `user_audio`, the input carries one user audio message so the real
    `send_audio` edge runs; without it, `call()` is an agent-initiated turn
    that goes straight to the drain.

    The returned object is duck-typed, not a real `AgentInput` — `call()` only
    reads `new_messages` and `getattr(input, "scenario_state", None)`. The cast
    is the single contained white lie, so callers still get a typed contract.
    """
    messages: List[Any] = (
        [create_audio_message(user_audio, role="user")] if user_audio is not None else []
    )
    return cast(AgentInput, _WrapperCallInput(messages))


async def drive_call(
    adapter: VoiceAgentAdapter, agent_input: Optional[AgentInput] = None
) -> Any:
    """Drive one agent turn through the REAL production wrapper — `adapter.call()`.

    This is the generic tier-1 entry for wrapper-level adapter tests: nothing
    between the test and the adapter's outermost production entry point is
    stubbed, so a fix (or a regression) that only manifests on the real
    `call()` flow — send_audio framing, drain loop, transcript attachment —
    cannot hide behind a test seam. (The bug class that hid PR #697's P0:
    tests drove internals by name while production crashed in the wrapper
    that wires them together.)

    NOT covered: segment recording. `make_agent_input` carries no
    `scenario_state`, so `_AdapterRecorder` degrades to a no-op (see
    `adapter.py`). Pass an input that carries a real `scenario_state` if the
    recorder timeline is what you mean to exercise.

    Vendor transports should be faked at the NETWORK CLIENT boundary (e.g.
    monkeypatched `websockets.connect` / `genai.Client`), never by substituting
    a stub transport for adapter privates like `_ws` or `_session`.

    Returns `Any`, not `AgentReturnTypes`: the real return is that TypedDict
    union, but callers here inspect the assistant message directly
    (`result["content"]`), which the union forbids. The INPUT contract is the
    one that prevents caller mistakes, and it is typed.
    """
    return await adapter.call(agent_input if agent_input is not None else make_agent_input())


# ------------------------------------------------------- Twilio real-route harness


def make_connected_twilio_adapter(http_port: int = 0) -> TwilioAgentAdapter:
    """Construct an adapter with just enough state for the production
    ``run_stream_session`` wrapper + ``recv_audio`` — without going through
    ``connect()`` (which would need live Twilio REST credentials to resolve the
    phone-number SID).

    Everything the media-stream path touches is the real object: the webhook
    server, its FastAPI app, and its ``/twilio/stream`` route. Only ``_rest`` is
    a stand-in, and only ``_assert_connected``'s ``is not None`` check reads it.
    """
    # All credential-shaped values are deliberately non-credentials: this module
    # ships inside the published package, so a literal like `auth_token="secret"`
    # would read as a real leak to a downstream secret scanner grepping
    # site-packages. The phone number is inside NANPA's reserved fiction block
    # (555-0100..555-0199) so it can never route to a real subscriber.
    adapter = TwilioAgentAdapter(
        account_sid="AC" + "0" * 32,
        auth_token="not-a-real-token",
        phone_number="+14155550195",
        public_base_url="https://example695.trycloudflare.com",
        http_port=http_port,
    )
    # Stand-in for the REST client: only _assert_connected's `is not None`
    # check reads it, and constructing a real one needs live Twilio credentials.
    adapter._rest = object()  # type: ignore[assignment]  # sentinel; never called
    adapter._inbound_queue = asyncio.Queue()
    adapter._stream_connected = asyncio.Event()
    adapter._server_shutdown = asyncio.Event()
    adapter._webhook_server = TwilioWebhookServer(adapter)
    return adapter


def free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


async def _wait_for_bind(port: int, server_task: "asyncio.Task[None]") -> None:
    """Wait until the port accepts, failing loudly if uvicorn died instead.

    ``free_port`` reserves then releases a port, so another listener can win
    the race. uvicorn reacts to a failed bind with ``sys.exit(1)`` — a
    ``SystemExit``,
    which is a ``BaseException`` and therefore slips past the ``suppress(Exception)``
    in ``TwilioWebhookServer.run()``. Without this check the connect below would
    succeed against the *other* listener and the test would fail much later with a
    bare ``SystemExit`` instead of "address already in use".
    """
    for _ in range(200):
        if server_task.done():
            # Re-raise whatever killed the server (SystemExit, OSError, …).
            server_task.result()
            raise AssertionError("uvicorn exited before binding")
        try:
            _reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.close()
            return
        except OSError:
            await asyncio.sleep(0.05)
    raise AssertionError(f"uvicorn never bound 127.0.0.1:{port}")


@asynccontextmanager
async def serve_real_twilio_route(
    adapter: TwilioAgentAdapter,
) -> AsyncIterator[str]:
    """Boot the adapter's REAL uvicorn server and yield the ``ws://`` URL of the
    REAL ``/twilio/stream`` route.

    This is the production entry point end to end: uvicorn → FastAPI →
    ``_stream()`` → ``run_stream_session`` → ``media_stream_loop``. No seam, no
    socket double. A fix that only works when a test calls the wrapper by name
    cannot pass through here.
    """
    assert adapter._webhook_server is not None
    server_task = asyncio.create_task(adapter._webhook_server.run())
    try:
        await _wait_for_bind(adapter.http_port, server_task)
        yield f"ws://127.0.0.1:{adapter.http_port}/twilio/stream"
    finally:
        assert adapter._server_shutdown is not None
        adapter._server_shutdown.set()
        with suppress(Exception):
            await asyncio.wait_for(server_task, timeout=5.0)


async def wait_for_twilio_stream_teardown(adapter: TwilioAgentAdapter) -> None:
    """Wait until the route handler's ``finally`` has nulled the transport."""
    for _ in range(200):
        if adapter._stream_ws is None:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("production route never tore the transport down")


async def drive_twilio_production(adapter: TwilioAgentAdapter, ws: Any) -> None:
    """Run the production per-connection wrapper
    (``TwilioWebhookServer.run_stream_session`` — what the ``/twilio/stream``
    route delegates to, as ``TestRealRoute`` in
    ``tests/voice/test_twilio_silent_stop_drain.py`` proves) to its terminal
    over the given socket double.

    On return, ``adapter._stream_ws`` / ``_stream_sid`` have been nulled by the
    wrapper's ``finally`` — exactly as in production after a call ends. Used for
    the terminations a real socket cannot produce (a ``receive_text`` that raises
    a non-disconnect error; a second session on the same connected adapter).
    """
    assert adapter._webhook_server is not None
    await adapter._webhook_server.run_stream_session(ws)
