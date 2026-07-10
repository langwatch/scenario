"""ElevenLabs-specific voice-span attributes (#770 / #771).

Drives the REAL ``ElevenLabsAgentAdapter`` through the executor connect/disconnect
loops with a faked WebSocket, asserting the EL contributions onto the base spans:
``voice.elevenlabs.agent_id`` on ``voice.adapter.connect`` and the pump counters
on ``voice.adapter.disconnect`` (A2 / A8, EL portion). Also guards H1: the 20 ms
pump emits NO per-tick span.
"""

import asyncio
import json

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.util._once import Once
from unittest.mock import AsyncMock, patch

from scenario.scenario_executor import ScenarioExecutor
from scenario.voice import ElevenLabsAgentAdapter

from ._span_assert import attrs, int_attr


@pytest.fixture(autouse=True)
def reset_otel():
    def _reset() -> None:
        trace._TRACER_PROVIDER = None
        trace._TRACER_PROVIDER_SET_ONCE = Once()

    _reset()
    yield
    _reset()


def _install_in_memory_provider() -> InMemorySpanExporter:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    return exporter


def _by_name(spans):
    return {s.name: s for s in spans}


class _FakeWs:
    """Minimal ElevenLabs socket double: modern websockets ``state`` enum."""

    def __init__(self) -> None:
        from websockets.protocol import State

        self._State = State
        self.state = State.OPEN
        self.sent: list[str] = []

    async def send(self, data: str) -> None:
        self.sent.append(data)

    async def recv(self) -> str:  # pragma: no cover - not exercised
        await asyncio.sleep(3600)
        return ""

    async def close(self) -> None:
        self.state = self._State.CLOSED


def _exec(adapter) -> ScenarioExecutor:
    return ScenarioExecutor(
        name="el-voice-span-test", description="test", agents=[adapter], script=[]
    )


@pytest.mark.asyncio
async def test_el_connect_span_carries_agent_id_and_disconnect_carries_pump_counters():
    """A2/A8 (EL): agent_id lands on the connect span; pump counters on disconnect;
    the pump emits NO per-tick span (H1)."""
    exporter = _install_in_memory_provider()
    adapter = ElevenLabsAgentAdapter(agent_id="agent-xyz", api_key="xi-test")
    executor = _exec(adapter)

    with patch("websockets.connect", new=AsyncMock(return_value=_FakeWs())):
        await executor._voice_connect_all()
        # Let the 20 ms pump run several idle (silence) ticks.
        await asyncio.sleep(0.12)
        await executor._voice_disconnect_all()

    spans = _by_name(exporter.get_finished_spans())

    connect = spans["voice.adapter.connect"]
    assert attrs(connect)["voice.adapter.class"] == "ElevenLabsAgentAdapter"
    assert attrs(connect)["voice.elevenlabs.agent_id"] == "agent-xyz"

    disconnect = spans["voice.adapter.disconnect"]
    assert int_attr(disconnect, "voice.elevenlabs.pump.ticks_total") >= 1
    assert int_attr(disconnect, "voice.elevenlabs.pump.silence_frames_sent") >= 1
    assert attrs(disconnect)["voice.elevenlabs.pump.unexpected_errors"] == 0

    # H1: the pump ticked many times but emitted NO per-tick span — only the two
    # lifecycle spans are present (+ nothing named voice.pump.* / voice.audio.*).
    voice_names = sorted(n for n in spans if n.startswith("voice."))
    assert voice_names == ["voice.adapter.connect", "voice.adapter.disconnect"]


@pytest.mark.asyncio
async def test_el_pump_span_count_invariant_to_tick_count():
    """A8 (H1 falsifier): more pump ticks must NOT create more spans — the finished
    span count is invariant to how long the pump ran."""

    async def _run(sleep_s: float) -> int:
        # Fresh provider per run — reset the set-once guard so the second install
        # is not silently dropped (OTel allows set_tracer_provider only once).
        trace._TRACER_PROVIDER = None
        trace._TRACER_PROVIDER_SET_ONCE = Once()
        exporter = _install_in_memory_provider()
        adapter = ElevenLabsAgentAdapter(agent_id="a", api_key="xi-test")
        executor = _exec(adapter)
        with patch("websockets.connect", new=AsyncMock(return_value=_FakeWs())):
            await executor._voice_connect_all()
            await asyncio.sleep(sleep_s)
            await executor._voice_disconnect_all()
        return len(
            [s for s in exporter.get_finished_spans() if s.name.startswith("voice.")]
        )

    short = await _run(0.04)   # ~2 ticks
    long = await _run(0.20)    # ~10 ticks
    assert short == long == 2  # two lifecycle spans regardless of tick count
