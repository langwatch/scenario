"""Executor-loop span tests for voice instrumentation (#770 / #771).

The ``voice.adapter.connect`` / ``voice.adapter.disconnect`` spans wrap the
executor's ``_voice_connect_all`` / ``_voice_disconnect_all`` loops (the base
adapter's connect/disconnect are abstract, so the loop is the one shared site).
Covers A2, A8 (generic-adapter portion), and the A-regression text-only case.
The EL-specific attributes (agent_id, pump counters) are exercised in
``test_voice_spans_elevenlabs.py``.
"""

import asyncio

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import StatusCode
from opentelemetry.util._once import Once

from scenario.scenario_executor import ScenarioExecutor
from scenario.voice import AdapterCapabilities, AudioChunk, VoiceAgentAdapter


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


class _ConnAdapter(VoiceAgentAdapter):
    capabilities = AdapterCapabilities(
        input_formats=["pcm16/24000"], output_formats=["pcm16/24000"]
    )

    def __init__(self, fail: bool = False):
        super().__init__()
        self._fail = fail
        self.connected = False

    async def connect(self):
        if self._fail:
            raise ConnectionRefusedError("simulated connect failure")
        self.connected = True

    async def disconnect(self):
        self.connected = False

    async def send_audio(self, chunk: AudioChunk) -> None:
        pass

    async def recv_audio(self, timeout: float) -> AudioChunk:
        raise asyncio.TimeoutError


def _exec(adapter) -> ScenarioExecutor:
    return ScenarioExecutor(
        name="voice-span-executor-test",
        description="test",
        agents=[adapter],
        script=[],
    )


# --- A2 -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a2_connect_span_ok():
    """A2: the executor connect loop emits one voice.adapter.connect span, OK."""
    exporter = _install_in_memory_provider()
    await _exec(_ConnAdapter())._voice_connect_all()
    span = _by_name(exporter.get_finished_spans())["voice.adapter.connect"]
    assert span.attributes["voice.adapter.class"] == "_ConnAdapter"
    assert span.status.status_code != StatusCode.ERROR


@pytest.mark.asyncio
async def test_a2_connect_span_error_records_original():
    """A2: a connect failure marks the span ERROR (before the executor re-wrap)."""
    exporter = _install_in_memory_provider()
    with pytest.raises(Exception):
        await _exec(_ConnAdapter(fail=True))._voice_connect_all()
    span = _by_name(exporter.get_finished_spans())["voice.adapter.connect"]
    assert span.status.status_code == StatusCode.ERROR


# --- A8 (generic disconnect portion) -----------------------------------------


@pytest.mark.asyncio
async def test_a8_disconnect_span_ok():
    """A8: the executor disconnect loop emits one voice.adapter.disconnect span."""
    exporter = _install_in_memory_provider()
    executor = _exec(_ConnAdapter())
    await executor._voice_connect_all()
    await executor._voice_disconnect_all()
    span = _by_name(exporter.get_finished_spans())["voice.adapter.disconnect"]
    assert span.attributes["voice.adapter.class"] == "_ConnAdapter"
    assert span.status.status_code != StatusCode.ERROR


# --- A-regression -------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_regression_connect_disconnect_span_names_and_no_stray():
    """A-regression (structure): connect/disconnect emit exactly their two named
    spans across a connect+disconnect cycle — no turn/audio spans leak in when no
    turn ran, and the two lifecycle spans are top-level (not under a turn)."""
    exporter = _install_in_memory_provider()
    executor = _exec(_ConnAdapter())
    await executor._voice_connect_all()
    await executor._voice_disconnect_all()
    voice_spans = [
        s for s in exporter.get_finished_spans() if s.name.startswith("voice.")
    ]
    names = sorted(s.name for s in voice_spans)
    assert names == ["voice.adapter.connect", "voice.adapter.disconnect"]
    # No turn ran → no turn/audio spans, and the lifecycle spans have no voice parent.
    for s in voice_spans:
        assert s.parent is None or s.parent.span_id not in {
            v.context.span_id for v in voice_spans
        }
