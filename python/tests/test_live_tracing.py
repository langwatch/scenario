"""Unit tests for ``scenario._tracing.live.RealtimeLangWatchSession``.

Covers AC1-AC14 from ``specs/realtime-live-tracing.feature``.

OTel global-provider state is process-global AND set-once-guarded, so every
test runs against a fully reset provider via the autouse ``reset_otel`` fixture.
The reset MUST clear both ``trace._TRACER_PROVIDER`` and the
``trace._TRACER_PROVIDER_SET_ONCE`` guard — otherwise the second
``set_tracer_provider()`` across the whole test session is silently dropped with
an "Overriding of current TracerProvider is not allowed" warning, which would
make every test after the first attach to a stale provider.
"""

import logging
import pathlib

import pytest

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import ProxyTracerProvider
from opentelemetry.util._once import Once

import scenario
import scenario._tracing.setup as setup_mod
from scenario._tracing.live import RealtimeLangWatchSession


API_KEY = "test-key-123"


@pytest.fixture(autouse=True)
def reset_otel():
    """Reset OTel global provider state (and the set-once guard) around each test."""

    def _reset() -> None:
        trace._TRACER_PROVIDER = None
        # Without resetting the Once guard, only the FIRST set_tracer_provider
        # in the whole process takes effect; every later one is dropped.
        trace._TRACER_PROVIDER_SET_ONCE = Once()
        setup_mod._reset_tracing_for_tests()

    _reset()
    yield
    _reset()


@pytest.fixture(autouse=True)
def clear_langwatch_key(monkeypatch: pytest.MonkeyPatch):
    """Start every test with LANGWATCH_API_KEY absent.

    Tests that need a key set it explicitly via ``set_key`` / monkeypatch so the
    no-op vs active branch is never decided by ambient environment.
    """
    monkeypatch.delenv("LANGWATCH_API_KEY", raising=False)
    yield


def _install_in_memory_provider() -> InMemorySpanExporter:
    """Install a concrete TracerProvider with an InMemorySpanExporter and return it.

    The helper, on entry, detects this concrete provider and attaches to it (the
    "existing provider" branch) rather than creating its own — so spans it emits
    are recorded by the returned exporter.
    """
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    return exporter


# --- AC1, AC9 ---------------------------------------------------------------


def test_ac1_importable_from_scenario_package():
    """AC1: realtime_langwatch_session is importable from the scenario package."""
    assert hasattr(scenario, "realtime_langwatch_session")
    assert scenario.realtime_langwatch_session is RealtimeLangWatchSession
    assert "realtime_langwatch_session" in scenario.__all__


def test_ac9_importing_scenario_does_not_create_tracer_provider():
    """AC9: importing scenario alone leaves a ProxyTracerProvider (no concrete one)."""
    # reset_otel has just reset to a fresh proxy. Merely having imported scenario
    # (done at module load) must not have installed a concrete provider.
    provider = trace.get_tracer_provider()
    assert isinstance(provider, ProxyTracerProvider)


# --- AC2 --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac2_log_turn_emits_child_llm_span_with_attributes(
    monkeypatch: pytest.MonkeyPatch,
):
    """AC2: log_turn emits exactly one 'realtime_turn' LLM span with all attributes."""
    monkeypatch.setenv("LANGWATCH_API_KEY", API_KEY)
    exporter = _install_in_memory_provider()

    async with scenario.realtime_langwatch_session(model="gpt-4o-realtime-preview") as session:
        await session.log_turn(
            user_transcript="Hello",
            agent_transcript="Hi there",
            model="gpt-4o-realtime-preview",
            latency_ms=450,
        )

    spans = exporter.get_finished_spans()
    turn_spans = [s for s in spans if s.name == "realtime_turn"]
    assert len(turn_spans) == 1
    span = turn_spans[0]
    assert span.attributes is not None
    assert span.attributes["type"] == "llm"
    assert span.attributes["input"] == "Hello"
    assert span.attributes["output"] == "Hi there"
    assert span.attributes["model"] == "gpt-4o-realtime-preview"
    assert span.attributes["latency_ms"] == 450
    # AC2 requires the turn span to be a *child* of the root span — verify the link
    root_spans = [s for s in spans if s.name != "realtime_turn"]
    assert len(root_spans) >= 1, "expected a root span"
    parent_ctx = span.parent
    assert parent_ctx is not None, "turn span should have a parent"
    root_ctx = root_spans[0].context
    assert root_ctx is not None, "root span should have a context"
    assert parent_ctx.span_id == root_ctx.span_id


# --- AC3 --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac3_no_op_when_api_key_absent():
    """AC3: with no key, enter + log_turn raise nothing and record zero spans."""
    # clear_langwatch_key already removed the env var.
    exporter = _install_in_memory_provider()

    async with scenario.realtime_langwatch_session(model="gpt-4o-realtime-preview") as session:
        await session.log_turn(
            user_transcript="anything",
            agent_transcript="anything back",
            model="gpt-4o-realtime-preview",
            latency_ms=123,
        )

    spans = exporter.get_finished_spans()
    turn_spans = [s for s in spans if s.name == "realtime_turn"]
    assert turn_spans == []


# --- AC4 --------------------------------------------------------------------


def test_ac4_no_import_from_tracing_setup():
    """AC4: live.py exists and has no import line from scenario._tracing.setup."""
    live_path = (
        pathlib.Path(__file__).parent.parent / "scenario" / "_tracing" / "live.py"
    )
    assert live_path.exists()

    import re

    src = live_path.read_text()
    offending = [
        line
        for line in src.splitlines()
        if re.match(r"^(from|import) .*_tracing\.setup", line)
    ]
    assert offending == [], f"live.py must not import from _tracing.setup: {offending}"


@pytest.mark.asyncio
async def test_ac4_usable_without_scenario_run_ever_called(
    monkeypatch: pytest.MonkeyPatch,
):
    """AC4: the helper works in a process where scenario.run() / setup was never called.

    setup_mod.ensure_tracing_initialized() is the function run() calls; we assert it was
    never triggered (setup remains uninitialized) yet the helper still functions.
    """
    monkeypatch.setenv("LANGWATCH_API_KEY", API_KEY)
    exporter = _install_in_memory_provider()

    assert setup_mod._initialized is False

    async with scenario.realtime_langwatch_session(model="gpt-4o-realtime-preview") as session:
        await session.log_turn(
            user_transcript="u",
            agent_transcript="a",
            model="gpt-4o-realtime-preview",
            latency_ms=10,
        )

    # Helper did its own setup; the run()-path init flag was never flipped.
    assert setup_mod._initialized is False
    turn_spans = [s for s in exporter.get_finished_spans() if s.name == "realtime_turn"]
    assert len(turn_spans) == 1


# --- AC5a -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac5a_creates_new_tracer_provider_when_none_exists(
    monkeypatch: pytest.MonkeyPatch,
):
    """AC5a: fresh ProxyTracerProvider + key → entering installs a concrete TracerProvider."""
    monkeypatch.setenv("LANGWATCH_API_KEY", API_KEY)
    # reset_otel leaves a fresh proxy; do NOT install a concrete one here.
    assert isinstance(trace.get_tracer_provider(), ProxyTracerProvider)

    async with scenario.realtime_langwatch_session(model="gpt-4o-realtime-preview"):
        provider = trace.get_tracer_provider()
        assert isinstance(provider, TracerProvider)
        assert not isinstance(provider, ProxyTracerProvider)


# --- AC5b -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac5b_attaches_to_existing_provider_without_replacing(
    monkeypatch: pytest.MonkeyPatch,
):
    """AC5b: an existing concrete provider is reused (same object) and captures the span."""
    monkeypatch.setenv("LANGWATCH_API_KEY", API_KEY)
    exporter = _install_in_memory_provider()
    existing = trace.get_tracer_provider()
    existing_id = id(existing)

    async with scenario.realtime_langwatch_session(model="gpt-4o-realtime-preview") as session:
        assert id(trace.get_tracer_provider()) == existing_id
        await session.log_turn(
            user_transcript="hi",
            agent_transcript="hello",
            model="gpt-4o-realtime-preview",
            latency_ms=42,
        )

    assert id(trace.get_tracer_provider()) == existing_id
    turn_spans = [s for s in exporter.get_finished_spans() if s.name == "realtime_turn"]
    assert len(turn_spans) == 1


# --- AC6 --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac6_export_failure_does_not_propagate_and_warns(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    """AC6: a processor whose on_end raises is swallowed; a WARNING is logged."""
    monkeypatch.setenv("LANGWATCH_API_KEY", API_KEY)

    # Concrete provider whose span processor raises on span end.
    provider = TracerProvider()
    exporter = InMemorySpanExporter()
    processor = SimpleSpanProcessor(exporter)

    def boom(_span):
        raise RuntimeError("simulated export failure")

    monkeypatch.setattr(processor, "on_end", boom)
    provider.add_span_processor(processor)
    trace.set_tracer_provider(provider)

    with caplog.at_level(logging.WARNING, logger="scenario.tracing"):
        async with scenario.realtime_langwatch_session(
            model="gpt-4o-realtime-preview"
        ) as session:
            # Must not raise out of log_turn even though on_end blows up.
            await session.log_turn(
                user_transcript="hi",
                agent_transcript="hello",
                model="gpt-4o-realtime-preview",
                latency_ms=42,
            )
        # Must not raise out of the async-with block either.

    warnings = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and r.name == "scenario.tracing"
    ]
    assert warnings, "expected at least one WARNING from scenario.tracing"


# --- AC7 --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac7_log_turn_before_enter_raises_runtimeerror(
    monkeypatch: pytest.MonkeyPatch,
):
    """AC7: calling log_turn before __aenter__ raises RuntimeError naming the helper."""
    monkeypatch.setenv("LANGWATCH_API_KEY", API_KEY)
    session = RealtimeLangWatchSession(model="gpt-4o-realtime-preview")

    with pytest.raises(RuntimeError, match="realtime_langwatch_session"):
        await session.log_turn(
            user_transcript="hi",
            agent_transcript="hello",
            model="gpt-4o-realtime-preview",
            latency_ms=42,
        )


@pytest.mark.asyncio
async def test_ac7_log_turn_after_exit_raises_runtimeerror(
    monkeypatch: pytest.MonkeyPatch,
):
    """AC7: calling log_turn after __aexit__ raises RuntimeError naming the helper."""
    monkeypatch.setenv("LANGWATCH_API_KEY", API_KEY)
    _install_in_memory_provider()

    session = RealtimeLangWatchSession(model="gpt-4o-realtime-preview")
    async with session:
        pass

    with pytest.raises(RuntimeError, match="realtime_langwatch_session"):
        await session.log_turn(
            user_transcript="hi",
            agent_transcript="hello",
            model="gpt-4o-realtime-preview",
            latency_ms=42,
        )


# --- AC8 --------------------------------------------------------------------


def _doc_path() -> pathlib.Path:
    return (
        pathlib.Path(__file__).parent.parent.parent
        / "docs/docs/pages/voice/happy-path-openai-realtime.mdx"
    )


def test_ac8_doc_has_live_app_tracing_section():
    """AC8: the realtime doc has the live-app tracing heading + code block."""
    doc = _doc_path()
    assert doc.exists(), f"doc not found at {doc}"
    text = doc.read_text()

    heading = "## Getting LangWatch traces from your live app"
    assert heading in text, "live-app tracing heading missing from doc"

    # Code block under the heading must show the async-with usage.
    after_heading = text.split(heading, 1)[1]
    # bound the section at the next top-level heading
    section = after_heading.split("\n## ", 1)[0]
    assert "async with realtime_langwatch_session(" in section


def test_ac8_doc_section_only_references_two_keys():
    """AC8: the section's *_KEY env var names are exactly OPENAI_API_KEY + LANGWATCH_API_KEY."""
    import re

    text = _doc_path().read_text()
    heading = "## Getting LangWatch traces from your live app"
    section = text.split(heading, 1)[1].split("\n## ", 1)[0]

    keys = sorted(set(re.findall(r"[A-Z_]+_KEY", section)))
    assert keys == ["LANGWATCH_API_KEY", "OPENAI_API_KEY"], keys


# --- AC10 -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac10_run_then_helper_no_duplicate_provider(
    monkeypatch: pytest.MonkeyPatch,
):
    """AC10: after ensure_tracing_initialized() (simulating run()), the helper reuses the provider."""
    monkeypatch.setenv("LANGWATCH_API_KEY", API_KEY)

    # Simulate scenario.run() having initialized tracing already.
    setup_mod.ensure_tracing_initialized()
    provider_before = trace.get_tracer_provider()
    provider_id = id(provider_before)

    async with scenario.realtime_langwatch_session(model="gpt-4o-realtime-preview"):
        assert id(trace.get_tracer_provider()) == provider_id

    assert id(trace.get_tracer_provider()) == provider_id


# --- AC11 -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac11_helper_then_run_coexistence(monkeypatch: pytest.MonkeyPatch):
    """AC11: after the helper exits, ensure_tracing_initialized() runs cleanly and flips _initialized."""
    monkeypatch.setenv("LANGWATCH_API_KEY", API_KEY)

    async with scenario.realtime_langwatch_session(model="gpt-4o-realtime-preview") as session:
        await session.log_turn(
            user_transcript="u",
            agent_transcript="a",
            model="gpt-4o-realtime-preview",
            latency_ms=10,
        )

    # run()'s init path must proceed without an OTel conflict.
    setup_mod.ensure_tracing_initialized()
    assert setup_mod._initialized is True


# --- AC12 -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac12_empty_transcripts_and_zero_latency(
    monkeypatch: pytest.MonkeyPatch,
):
    """AC12: empty transcripts and zero latency still produce exactly one span, no error."""
    monkeypatch.setenv("LANGWATCH_API_KEY", API_KEY)
    exporter = _install_in_memory_provider()

    async with scenario.realtime_langwatch_session(model="gpt-4o-realtime-preview") as session:
        await session.log_turn(
            user_transcript="",
            agent_transcript="",
            model="gpt-4o-realtime-preview",
            latency_ms=0,
        )

    turn_spans = [s for s in exporter.get_finished_spans() if s.name == "realtime_turn"]
    assert len(turn_spans) == 1
    span = turn_spans[0]
    assert span.attributes is not None
    assert span.attributes["input"] == ""
    assert span.attributes["output"] == ""
    assert span.attributes["latency_ms"] == 0


# --- AC13 -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac13_multiple_sequential_turns_emit_independent_spans(
    monkeypatch: pytest.MonkeyPatch,
):
    """AC13: two log_turn calls produce two independent spans with their own attributes."""
    monkeypatch.setenv("LANGWATCH_API_KEY", API_KEY)
    exporter = _install_in_memory_provider()

    async with scenario.realtime_langwatch_session(model="gpt-4o-realtime-preview") as session:
        await session.log_turn(
            user_transcript="Turn 1 user",
            agent_transcript="Turn 1 agent",
            model="gpt-4o-realtime-preview",
            latency_ms=100,
        )
        await session.log_turn(
            user_transcript="Turn 2 user",
            agent_transcript="Turn 2 agent",
            model="gpt-4o-realtime-preview",
            latency_ms=200,
        )

    turn_spans = [s for s in exporter.get_finished_spans() if s.name == "realtime_turn"]
    assert len(turn_spans) == 2

    for s in turn_spans:
        assert s.attributes is not None
    by_input = {s.attributes["input"]: s for s in turn_spans if s.attributes is not None}
    assert by_input["Turn 1 user"].attributes is not None
    assert by_input["Turn 1 user"].attributes["output"] == "Turn 1 agent"
    assert by_input["Turn 1 user"].attributes["latency_ms"] == 100
    assert by_input["Turn 2 user"].attributes is not None
    assert by_input["Turn 2 user"].attributes["output"] == "Turn 2 agent"
    assert by_input["Turn 2 user"].attributes["latency_ms"] == 200


# --- AC14 -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac14_aexit_flushes_span_visible_after_block(
    monkeypatch: pytest.MonkeyPatch,
):
    """AC14: the span emitted inside the block is present in finished spans after exit."""
    monkeypatch.setenv("LANGWATCH_API_KEY", API_KEY)
    exporter = _install_in_memory_provider()

    async with scenario.realtime_langwatch_session(model="gpt-4o-realtime-preview") as session:
        await session.log_turn(
            user_transcript="hi",
            agent_transcript="hello",
            model="gpt-4o-realtime-preview",
            latency_ms=42,
        )

    # Observed strictly AFTER the with-block exits.
    turn_spans = [s for s in exporter.get_finished_spans() if s.name == "realtime_turn"]
    assert len(turn_spans) == 1


@pytest.mark.asyncio
async def test_ac14_aexit_does_not_raise_with_no_turns(
    monkeypatch: pytest.MonkeyPatch,
):
    """AC14: exiting without logging any turn does not raise."""
    monkeypatch.setenv("LANGWATCH_API_KEY", API_KEY)
    _install_in_memory_provider()

    async with scenario.realtime_langwatch_session(model="gpt-4o-realtime-preview"):
        pass  # no turns logged

    # Reaching here without an exception is the assertion.


@pytest.mark.asyncio
async def test_ac14_aexit_does_not_raise_with_no_key():
    """AC14 (no-op branch): exiting a keyless session with no turns does not raise."""
    # clear_langwatch_key removed the key.
    async with scenario.realtime_langwatch_session(model="gpt-4o-realtime-preview"):
        pass
