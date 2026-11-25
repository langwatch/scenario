"""
Shared a-leg test harness (scenario#762): a media-socket double, an a-leg
origination helper, and the two ways to drive the media stream.

Deliberately NOT named ``test_*`` so pytest does not collect it: the nonce
tests, the DTMF guard, the frame-loop tripwire and the call-duration suite all
drive the a-leg path through ONE socket double instead of four divergent ones.
Direct twin of ``javascript/src/voice/adapters/__tests__/a-leg-harness.ts``.
"""

import asyncio
import json
import re
from contextlib import asynccontextmanager, suppress
from typing import Any, AsyncIterator, Optional

from scenario.voice import TwilioAgentAdapter
from scenario.voice.adapters._twilio_server import TwilioWebhookServer


#: The SID ``FakeREST.place_call`` returns — the call a-leg mode originated.
ORIGINATED_CALL_SID = "CA" + "1" * 32
#: The one external number the a-leg tests may dial. Ofcom's drama range, which
#: is permanently unassignable — a copy-paste into a live config dials nobody.
A_LEG_DESTINATION = "+447700900123"
NONCE_RE = re.compile(r'<Parameter name="nonce" value="([^"]+)"/>')


def _start_frame(
    *,
    nonce: Optional[str],
    call_sid: str = ORIGINATED_CALL_SID,
    stream_sid: str = "MZ762",
) -> str:
    """A Twilio ``start`` frame, optionally carrying a ``nonce`` custom parameter."""
    start: dict[str, Any] = {"streamSid": stream_sid, "callSid": call_sid}
    if nonce is not None:
        start["customParameters"] = {"nonce": nonce}
    return json.dumps({"event": "start", "start": start})


class _ScriptedWS:
    """Media-stream socket double: serves ``frames`` in order, then parks.

    Parking (rather than raising) at exhaustion models a socket Twilio holds
    open, so a test can assert that a rejected socket is CLOSED by the loop
    rather than merely running out of frames. ``disconnect_at_end=True`` instead
    models the client hanging up — what an attacker who connects and
    immediately closes looks like on the wire.

    ``parked`` fires once the loop asks for a frame that is not there, i.e. once
    every scripted frame has been fully handled. That is the observable the
    drivers below wait on, so no test has to guess at a sleep.
    """

    def __init__(
        self,
        frames: list[str],
        *,
        disconnect_at_end: bool = False,
        gate: Optional[asyncio.Event] = None,
    ) -> None:
        self._frames = list(frames)
        self._idx = 0
        self._disconnect_at_end = disconnect_at_end
        # ``gate`` models a socket that connected before ``place_call`` armed the
        # nonce: its first frame is withheld until the test sets the gate (after
        # arming), so the loop must consult live nonce state, not a loop-entry
        # snapshot.
        self._gate = gate
        self._gate_awaited = False
        self.closed = False
        self.sent: list[str] = []
        self.parked = asyncio.Event()

    async def accept(self) -> None:
        return None

    async def receive_text(self) -> str:
        if self._gate is not None and not self._gate_awaited:
            self._gate_awaited = True
            await self._gate.wait()
        if self._idx < len(self._frames):
            msg = self._frames[self._idx]
            self._idx += 1
            return msg
        self.parked.set()
        if self._disconnect_at_end:
            from fastapi import WebSocketDisconnect

            raise WebSocketDisconnect(code=1000)
        await asyncio.Event().wait()  # held open; never resolves
        raise AssertionError("unreachable")  # pragma: no cover

    async def send_text(self, text: str) -> None:
        self.sent.append(text)

    async def close(self) -> None:
        self.closed = True


async def _await_origination(rest: Any, count: int, timeout: float = 1.0) -> None:
    """Wait until ``place_call`` has recorded ``count`` REST dials.

    ``place_call`` now resets the stream-connected signal when dialing (#762 P1),
    so it no longer returns until a genuine socket authenticates. Tests drive it
    as a background task and use this to wait for the point PAST the reset where
    the origination TwiML — and the armed nonce — are observable, instead of a
    blind sleep. Twin of the JS harness' ``vi.waitUntil(placeCallArgs.length)``.
    """
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while len(rest.place_call_kwargs) < count:
        if loop.time() > deadline:
            raise AssertionError("place_call never reached origination")
        await asyncio.sleep(0)


async def _place_a_leg_call(
    a: TwilioAgentAdapter, rest: Any, *, timeout: float = 10.0
) -> tuple[str, "asyncio.Task[None]"]:
    """Start an a-leg ``place_call`` WITHOUT awaiting it; return its nonce and task.

    ``place_call`` resets the stream-connected signal when dialing and only
    resolves once a genuine socket authenticates (#762 P1), so the returned task
    IS the stream-connected signal: a rejected socket leaves it pending
    (``not task.done()``), and the socket that authenticates settles it — the twin
    of the JS harness' ``startALegCall`` returning ``{ nonce, call }``. Callers
    settle it by driving a genuine socket and awaiting the task, or by cancelling
    it at teardown.
    """
    call: "asyncio.Task[None]" = asyncio.create_task(
        a.place_call(to=A_LEG_DESTINATION, attach_stream="a-leg", timeout=timeout)
    )
    start = len(rest.place_call_kwargs)
    await _await_origination(rest, start + 1)
    match = NONCE_RE.search(rest.place_call_kwargs[-1]["twiml"])
    assert match is not None, "a-leg origination TwiML carries no nonce Parameter"
    return match.group(1), call


async def _place_call_and_connect(a: TwilioAgentAdapter, rest: Any, **kwargs: Any) -> None:
    """Run ``place_call`` to completion by signalling a connection once it dials.

    ``place_call`` now blocks until a socket authenticates (#762 P1); tests that
    only need the dial to COMPLETE (the REST body, the armed watchdog) and do not
    drive a real socket use this to settle it — the stand-in for the old
    pre-set-``_stream_connected`` idiom, now that the dial's own reset clears it.
    """
    start = len(rest.place_call_kwargs)
    call = asyncio.create_task(a.place_call(**kwargs))
    await _await_origination(rest, start + 1)
    assert a._stream_connected is not None
    a._stream_connected.set()
    _ = await call


async def _dial_then_connect(a: TwilioAgentAdapter, coro: Any) -> None:
    """Run a dial (``place_call``/``wait_for_call``) and fire the stream-connected
    signal once the dial has reset it and begun awaiting.

    ``place_call``/``wait_for_call`` now reset the connected signal when dialing
    (#762 P1) and only resolve once a socket connects, so a test that just needs
    the dial to COMPLETE (not a real socket) can no longer pre-set the signal
    before the dial. This fires it after the reset instead — the drop-in
    replacement for the old ``a._stream_connected.set(); await a.place_call(...)``.
    """
    task: "asyncio.Task[None]" = asyncio.create_task(coro)
    for _ in range(200):
        await asyncio.sleep(0)
        if task.done():
            break
        assert a._stream_connected is not None
        a._stream_connected.set()
    _ = await task


async def _cancel(call: "asyncio.Task[None]") -> None:
    """Cancel a still-pending ``place_call`` task and swallow its cancellation."""
    if not call.done():
        call.cancel()
    with suppress(asyncio.CancelledError, Exception):
        _ = await call


@asynccontextmanager
async def _driving(
    a: TwilioAgentAdapter,
    ws: _ScriptedWS,
    *,
    production: bool = False,
    timeout: float = 5.0,
) -> AsyncIterator[asyncio.Task]:
    """Run the media stream over ``ws`` for the body of the block.

    Waits on the OBSERVABLE — the loop returning, or the socket having served
    every scripted frame — rather than on a fixed sleep, so a slow machine does
    not silently truncate the run. ``timeout`` is a failure ceiling, not the
    expected wait. The loop keeps running inside the block: an accepted socket
    stays the adapter's live transport, and only the exit cancels it, so no
    assertion runs against a stream this helper tore down behind the test's back.

    ``production=True`` drives ``run_stream_session`` — the real
    ``/twilio/stream`` entry, including the ``finally`` that nulls the adapter's
    transport — instead of the bare loop.
    """
    server = TwilioWebhookServer(a)
    runner = server.run_stream_session if production else server.media_stream_loop
    task = asyncio.create_task(runner(ws))
    parked = asyncio.create_task(ws.parked.wait())
    try:
        done, _ = await asyncio.wait(
            {task, parked}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED
        )
        assert done, "media stream neither settled nor consumed its scripted frames"
        yield task
    finally:
        parked.cancel()
        task.cancel()
        await asyncio.gather(task, parked, return_exceptions=True)
