"""
Issue #839 — an agent-initiated hangup ends the scenario gracefully.

Hosted voice agents commonly hang up on purpose: an ElevenLabs agent invokes the
``end_call`` system tool right after its farewell, which closes the WebSocket.
When the scripted scenario still has ``agent()`` / ``user()`` steps left, the
next ``agent()`` used to raise ``TransportNotConnectedError`` and fail a run in
which the agent behaved exactly as designed.

The adapter now recognises the ``agent_tool_response`` frame EL emits for a
successful hangup tool and records it on ``agent_hung_up``; the base ``call()``
gate then concludes the conversation instead of raising.

Wire shape captured live from the real EL ConvAI transport::

    {"type": "agent_tool_response",
     "agent_tool_response": {"tool_name": "end_call",
       "tool_call_id": "end_call_bf80…", "tool_type": "system",
       "is_error": false, "is_blocked": false, "event_id": 20,
       "is_called": true}}

…followed by a clean close (code 1000).
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from scenario.types import AgentInput
from scenario.voice import ElevenLabsAgentAdapter


def _hangup_frame(
    tool_name: str = "end_call",
    *,
    is_called: bool = True,
    is_error: bool = False,
    is_blocked: bool = False,
) -> dict[str, Any]:
    return {
        "type": "agent_tool_response",
        "agent_tool_response": {
            "tool_name": tool_name,
            "tool_call_id": f"{tool_name}_abc123",
            "tool_type": "system",
            "is_error": is_error,
            "is_blocked": is_blocked,
            "event_id": 20,
            "is_called": is_called,
        },
    }


class FakeSocket:
    """In-memory EL socket that can also simulate a server-side close."""

    def __init__(self) -> None:
        self.sent: list[str] = []
        self._inbound: "asyncio.Queue[str]" = asyncio.Queue()
        self.closed = False

    async def send(self, data: str) -> None:
        self.sent.append(data)

    async def recv(self) -> str:
        raw = await self._inbound.get()
        if raw == "__CLOSE__":
            import websockets

            self.closed = True
            raise websockets.exceptions.ConnectionClosedOK(None, None)
        return raw

    async def close(self) -> None:
        self.closed = True

    def deliver(self, event: dict[str, Any]) -> None:
        self._inbound.put_nowait(json.dumps(event))

    def deliver_audio(self, byte_len: int = 4) -> None:
        self.deliver(
            {
                "type": "audio",
                "audio_event": {
                    "audio_base_64": base64.b64encode(b"\x01" * byte_len).decode()
                },
            }
        )

    def deliver_close(self) -> None:
        self._inbound.put_nowait("__CLOSE__")


async def _connected() -> tuple[ElevenLabsAgentAdapter, FakeSocket]:
    socket = FakeSocket()
    adapter = ElevenLabsAgentAdapter(agent_id="agent-test", api_key="xi-test")
    with patch("websockets.connect", new=AsyncMock(return_value=socket)):
        await adapter.connect()
    await adapter.stop_pump()
    return adapter, socket


def _agent_input() -> AgentInput:
    return AgentInput(
        thread_id="t-839",
        messages=[],
        new_messages=[],
        scenario_state=None,  # type: ignore[arg-type]  # the connected-state gate under test runs before scenario_state is read
    )


# --------------------------------------------------------------------------- #
# Detection                                                                    #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_end_call_tool_response_marks_the_call_as_agent_hung_up():
    adapter, socket = await _connected()
    assert adapter.agent_hung_up is False

    socket.deliver(_hangup_frame())
    socket.deliver_audio()  # lets recv_audio return after consuming the frame
    await adapter.recv_audio(timeout=1.0)

    assert adapter.agent_hung_up is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tool_name", ["transfer_to_agent", "transfer_to_number", "transfer_to_genesys"]
)
async def test_transfer_tools_also_count_as_the_agent_ending_this_session(tool_name):
    """A transfer hands the caller off — this session is over either way."""
    adapter, socket = await _connected()

    socket.deliver(_hangup_frame(tool_name))
    socket.deliver_audio()
    await adapter.recv_audio(timeout=1.0)

    assert adapter.agent_hung_up is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kwargs",
    [
        {"is_called": False},
        {"is_error": True},
        {"is_blocked": True},
    ],
    ids=["not-called", "errored", "blocked"],
)
async def test_unsuccessful_hangup_tool_does_not_mark_a_hangup(kwargs):
    """A hangup the agent did not actually complete is not a hangup — a close
    after one of these is a genuine transport failure and must still raise."""
    adapter, socket = await _connected()

    socket.deliver(_hangup_frame(**kwargs))
    socket.deliver_audio()
    await adapter.recv_audio(timeout=1.0)

    assert adapter.agent_hung_up is False


@pytest.mark.asyncio
async def test_unrelated_agent_tool_response_does_not_mark_a_hangup():
    adapter, socket = await _connected()

    socket.deliver(_hangup_frame("language_detection"))
    socket.deliver_audio()
    await adapter.recv_audio(timeout=1.0)

    assert adapter.agent_hung_up is False


# --------------------------------------------------------------------------- #
# The scripted turn that used to fail                                          #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_scripted_turn_after_a_hangup_concludes_instead_of_raising():
    """The #839 shape: agent says goodbye, hangs up, and the script still has a
    turn left. That turn must conclude, not fail the run."""
    adapter, socket = await _connected()

    # Farewell audio, then the hangup tool, then EL closes the socket.
    socket.deliver_audio()
    await adapter.recv_audio(timeout=1.0)
    socket.deliver(_hangup_frame())
    socket.deliver_close()
    terminal = await adapter.recv_audio(timeout=1.0)
    assert terminal.data == b"", "a close mid-receive ends the drain cleanly"

    assert adapter.agent_hung_up is True
    assert adapter.is_connected() is False

    # The leftover scripted agent() turn.
    result = await adapter.call(_agent_input())

    assert result == [], "concluding adds no messages; the script falls through"


@pytest.mark.asyncio
async def test_a_dropped_transport_still_raises():
    """Without a deliberate hangup, a disconnected adapter is still an error —
    the fix must not mask genuine transport failures."""
    from scenario.voice.adapters._stub import TransportNotConnectedError

    adapter, socket = await _connected()
    socket.deliver_close()
    await adapter.recv_audio(timeout=1.0)
    await adapter.disconnect()

    assert adapter.agent_hung_up is False
    with pytest.raises(TransportNotConnectedError):
        await adapter.call(_agent_input())
