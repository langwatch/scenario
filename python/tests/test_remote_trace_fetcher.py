"""
Unit tests for the remote trace fetcher.

Covers the settle-wait mechanics of
``scenario._tracing.remote_trace_fetcher`` against a fake HTTP layer.
Binds the @unit scenarios of specs/remote-trace-fetching.feature:
"A forced verdict settle-waits until the remote trace is complete",
"Chunked ingestion does not settle on a partial trace",
"An incomplete trace at the deadline keeps its spans and gains an error span",
"A trace containing only the scenario's own spans does not settle",
"The scenario's own spans echoed back do not block settling",
"Fetch failure produces a synthetic error span and inconclusive criteria
guidance" (the synthetic span half),
"Spans started by the scenario process never count as remote evidence",
"A finished scenario releases its traces from the process-span registry",
"The judge may wait once more when the traces are incomplete" (the
extend_settle half), and
"Remote spans deduplicate against locally collected spans".
"""

import asyncio
import time
from typing import Any, Dict, List, Optional

import pytest
from opentelemetry.trace import StatusCode

from scenario._tracing.judge_span_collector import JudgeSpanCollector
from scenario._tracing.remote_trace_fetcher import (
    ERROR_SPAN_NAME,
    RemoteTraceFetcher,
    _hex_or_hashed_id,
    convert_api_span,
    create_synthetic_error_span,
)


THREAD_ID = "scenariothread_test"
TRACE_A = "0af7651916cd43dd8448eb211c80319c"
TRACE_B = "1bf7651916cd43dd8448eb211c80319d"
TRACE_C = "2cf7651916cd43dd8448eb211c80319e"


def _api_span(
    span_id: str,
    *,
    trace_id: str = TRACE_A,
    name: str = "call llm",
    span_type: str = "llm",
    parent_id: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "trace_id": trace_id,
        "span_id": span_id,
        "parent_id": parent_id,
        "name": name,
        "type": span_type,
        "timestamps": {"started_at": 1721382486895, "finished_at": 1721382488392},
        "input": {"type": "text", "value": "what tables exist?"},
        "output": {"type": "text", "value": "there are 3 tables"},
    }


def _trace_response(trace_id: str, spans: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"trace_id": trace_id, "spans": spans}


class FakeClock:
    """Deterministic clock: sleep() advances monotonic() instantly."""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: List[float] = []

    def monotonic(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class FakeTraceApi:
    """Injectable HTTP layer: returns queued responses per trace id.

    Each queue entry is a trace response dict, None (404, not arrived), or
    an Exception instance (raised). The last entry repeats once exhausted.
    """

    def __init__(self, queues: Dict[str, List[Any]]) -> None:
        self.queues = {k: list(v) for k, v in queues.items()}
        self.calls: List[str] = []

    async def fetch(self, trace_id: str) -> Optional[Dict[str, Any]]:
        self.calls.append(trace_id)
        queue = self.queues.get(trace_id, [None])
        entry = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(entry, Exception):
            raise entry
        return entry


def _make_fetcher(api: FakeTraceApi, clock: FakeClock) -> RemoteTraceFetcher:
    return RemoteTraceFetcher(
        fetch_trace=api.fetch, sleep=clock.sleep, monotonic=clock.monotonic
    )


def _collected_names(collector: JudgeSpanCollector, thread_id: str) -> List[str]:
    return [s.name for s in collector.get_spans_for_thread(thread_id)]


class TestSettleTraces:
    """@scenario A forced verdict settle-waits until the remote trace is complete"""

    @pytest.mark.asyncio
    async def test_polls_until_the_fetched_spans_form_a_parent_resolved_trace(self):
        span = _api_span("a" * 16)
        api = FakeTraceApi(
            {
                TRACE_A: [
                    None,
                    None,
                    _trace_response(TRACE_A, [span]),
                ]
            }
        )
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)
        collector = JudgeSpanCollector()

        await fetcher.settle_traces(
            thread_id=THREAD_ID,
            trace_ids=[TRACE_A],
            collector=collector,
            timeout=60.0,
        )

        assert len(api.calls) == 3, (
            "two empty polls, then the parentless root arrives and the trace"
            " is parent-resolved with a remote span"
        )
        assert _collected_names(collector, THREAD_ID) == ["call llm"]

    @pytest.mark.asyncio
    async def test_chunked_ingestion_does_not_settle_on_a_partial_trace(self):
        """@scenario Chunked ingestion does not settle on a partial trace"""
        root = _api_span("f" * 16, name="agent request")
        child_one = _api_span("a" * 16, name="tool round one", parent_id="f" * 16)
        child_two = _api_span("b" * 16, name="query db", parent_id="f" * 16)
        partial = _trace_response(TRACE_A, [child_one])
        full = _trace_response(TRACE_A, [root, child_one, child_two])
        # The partial chunk repeats across three polls: the count is stable,
        # which a plain count-stability rule would have settled on, missing
        # the query db span entirely.
        api = FakeTraceApi({TRACE_A: [partial, partial, partial, full]})
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)
        collector = JudgeSpanCollector()

        await fetcher.settle_traces(
            thread_id=THREAD_ID,
            trace_ids=[TRACE_A],
            collector=collector,
            timeout=120.0,
        )

        assert len(api.calls) == 4, "keeps polling past the partial chunks"
        names = _collected_names(collector, THREAD_ID)
        assert "agent request" in names
        assert "query db" in names

    @pytest.mark.asyncio
    async def test_incomplete_trace_at_deadline_keeps_spans_and_gains_error_span(self):
        """@scenario An incomplete trace at the deadline keeps its spans and gains an error span"""
        orphan = _api_span("a" * 16, name="orphan tool", parent_id="e" * 16)
        api = FakeTraceApi({TRACE_A: [_trace_response(TRACE_A, [orphan])]})
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)
        collector = JudgeSpanCollector()

        await fetcher.settle_traces(
            thread_id=THREAD_ID,
            trace_ids=[TRACE_A],
            collector=collector,
            timeout=5.0,
        )

        calls_at_deadline = len(api.calls)
        assert calls_at_deadline > 3, "keeps polling until the deadline"

        await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=5.0
        )
        assert len(api.calls) == calls_at_deadline, (
            "the trace is terminally failed: a later settle adds no polls"
        )
        names = _collected_names(collector, THREAD_ID)
        assert "orphan tool" in names, "the collected spans stay with the judge"
        assert ERROR_SPAN_NAME in names
        error_span = next(
            s
            for s in collector.get_spans_for_thread(THREAD_ID)
            if s.name == ERROR_SPAN_NAME
        )
        reason = str(
            dict(error_span.attributes or {})[
                "langwatch.span_collection.error.reason"
            ]
        )
        assert "still incomplete" in reason

    @pytest.mark.asyncio
    async def test_local_echoes_with_open_parents_do_not_block_settling(self):
        """@scenario The scenario's own spans echoed back do not block settling"""
        adapter_span = convert_api_span(
            _api_span("b" * 16, name="adapter call"),
            trace_id=TRACE_A,
            thread_id=THREAD_ID,
        )
        assert adapter_span is not None
        collector = JudgeSpanCollector()
        collector.on_end(adapter_span)

        # The echo of the adapter span points at the still-open turn span,
        # which is neither fetched nor collected; the agent's own root
        # resolves against the collected adapter span.
        echo = _api_span("b" * 16, name="adapter call", parent_id="1" * 16)
        agent_root = _api_span("c" * 16, name="agent request", parent_id="b" * 16)
        api = FakeTraceApi(
            {TRACE_A: [_trace_response(TRACE_A, [echo, agent_root])]}
        )
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)

        await fetcher.settle_traces(
            thread_id=THREAD_ID,
            trace_ids=[TRACE_A],
            collector=collector,
            timeout=60.0,
        )

        assert len(api.calls) == 1, "settles on the first poll"
        names = _collected_names(collector, THREAD_ID)
        assert "agent request" in names
        assert ERROR_SPAN_NAME not in names

    @pytest.mark.asyncio
    async def test_local_only_trace_never_settles_and_times_out(self):
        """@scenario A trace containing only the scenario's own spans does not settle"""
        local_span_id = "a" * 16
        local_span = convert_api_span(
            _api_span(local_span_id, name="local llm call"),
            trace_id=TRACE_A,
            thread_id=THREAD_ID,
        )
        assert local_span is not None
        collector = JudgeSpanCollector()
        collector.on_end(local_span)

        api = FakeTraceApi(
            {
                TRACE_A: [
                    _trace_response(
                        TRACE_A, [_api_span(local_span_id, name="local llm call")]
                    )
                ]
            }
        )
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)

        await fetcher.settle_traces(
            thread_id=THREAD_ID,
            trace_ids=[TRACE_A],
            collector=collector,
            timeout=5.0,
        )

        calls_at_timeout = len(api.calls)
        assert calls_at_timeout > 3, "keeps polling until the timeout"

        await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=5.0
        )
        assert len(api.calls) == calls_at_timeout, (
            "the trace is terminally failed, not left pending"
        )
        names = _collected_names(collector, THREAD_ID)
        assert ERROR_SPAN_NAME in names
        error_span = next(
            s
            for s in collector.get_spans_for_thread(THREAD_ID)
            if s.name == ERROR_SPAN_NAME
        )
        reason = str(
            dict(error_span.attributes or {})[
                "langwatch.span_collection.error.reason"
            ]
        )
        assert "no agent spans arrived" in reason

    @pytest.mark.asyncio
    async def test_settles_all_unsettled_ids_in_parallel_under_one_deadline(self):
        span_a = _api_span("a" * 16, trace_id=TRACE_A)
        span_b = _api_span("b" * 16, trace_id=TRACE_B, name="query db")
        api = FakeTraceApi(
            {
                TRACE_A: [_trace_response(TRACE_A, [span_a])],
                TRACE_B: [None, _trace_response(TRACE_B, [span_b])],
            }
        )
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)
        collector = JudgeSpanCollector()

        await fetcher.settle_traces(
            thread_id=THREAD_ID,
            trace_ids=[TRACE_A, TRACE_B],
            collector=collector,
            timeout=60.0,
        )

        assert sorted(_collected_names(collector, THREAD_ID)) == [
            "call llm",
            "query db",
        ]

    @pytest.mark.asyncio
    async def test_already_settled_ids_are_not_polled_again(self):
        span = _api_span("a" * 16)
        api = FakeTraceApi({TRACE_A: [_trace_response(TRACE_A, [span])]})
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)
        collector = JudgeSpanCollector()

        await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=60.0
        )
        calls_after_first = len(api.calls)

        await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=60.0
        )

        assert len(api.calls) == calls_after_first


class TestDeadlineMidPoll:
    """@scenario A poll in flight at the deadline still yields the timeout reason"""

    @pytest.mark.asyncio
    async def test_slow_poll_completing_after_the_deadline_records_the_timeout_reason(
        self,
    ):
        clock = FakeClock()
        calls: List[str] = []

        async def slow_empty_fetch(trace_id: str) -> Optional[Dict[str, Any]]:
            # The response lands only after the settle deadline has passed:
            # the loop, not the request, owns the deadline, so the poll must
            # complete and the deadline branch must record the timeout reason.
            calls.append(trace_id)
            clock.now += 30.0
            return None

        fetcher = RemoteTraceFetcher(
            fetch_trace=slow_empty_fetch, sleep=clock.sleep, monotonic=clock.monotonic
        )
        collector = JudgeSpanCollector()

        await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=10.0
        )

        assert calls == [TRACE_A]
        names = _collected_names(collector, THREAD_ID)
        assert names == [ERROR_SPAN_NAME]
        [error_span] = collector.get_spans_for_thread(THREAD_ID)
        reason = str(
            dict(error_span.attributes or {})[
                "langwatch.span_collection.error.reason"
            ]
        )
        assert "no agent spans arrived" in reason
        assert "aborted" not in reason

    @pytest.mark.asyncio
    async def test_a_hanging_fetch_gives_up_at_the_configured_budget(self):
        """A stalled request must not outlive a short budget.

        The HTTP client's own timeout is ten seconds, so without the
        remaining-budget bound a run configured for half a second would still
        wait ten. The abort is ours, so the reason stays the timeout one.
        """
        collector = JudgeSpanCollector()

        async def hanging_fetch(trace_id: str) -> Optional[Dict[str, Any]]:
            await asyncio.sleep(30.0)
            return None

        # Real clock: the bound is enforced by asyncio, not by the fake one.
        fetcher = RemoteTraceFetcher(fetch_trace=hanging_fetch)

        started_at = time.monotonic()
        await fetcher.settle_traces(
            thread_id=THREAD_ID,
            trace_ids=[TRACE_A],
            collector=collector,
            timeout=0.5,
        )
        elapsed = time.monotonic() - started_at

        assert elapsed < 5.0
        [error_span] = collector.get_spans_for_thread(THREAD_ID)
        reason = str(
            dict(error_span.attributes or {})[
                "langwatch.span_collection.error.reason"
            ]
        )
        assert "no agent spans arrived" in reason


class TestFetchFailure:
    """@scenario Fetch failure produces a synthetic error span and inconclusive criteria guidance"""

    @pytest.mark.asyncio
    async def test_timeout_adds_one_synthetic_error_span_with_the_reason(self):
        api = FakeTraceApi({TRACE_A: [None]})
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)
        collector = JudgeSpanCollector()

        await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=3.0
        )

        spans = collector.get_spans_for_thread(THREAD_ID)
        assert [s.name for s in spans] == [ERROR_SPAN_NAME]
        error_span = spans[0]
        assert error_span.status.status_code == StatusCode.ERROR
        assert error_span.status.description is not None
        assert TRACE_A in error_span.status.description
        attributes = dict(error_span.attributes or {})
        assert attributes["langwatch.span_collection.error"] is True
        assert TRACE_A in str(
            attributes["langwatch.span_collection.error.reason"]
        )

    @pytest.mark.asyncio
    async def test_hard_failure_during_settle_adds_the_synthetic_error_span(self):
        api = FakeTraceApi({TRACE_A: [RuntimeError("connection refused")]})
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)
        collector = JudgeSpanCollector()

        await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=60.0
        )

        # A failing poll retries until the deadline instead of terminally
        # failing the trace on its first error.
        assert len(api.calls) > 1
        spans = collector.get_spans_for_thread(THREAD_ID)
        assert [s.name for s in spans] == [ERROR_SPAN_NAME]
        reason = str(
            dict(spans[0].attributes or {})["langwatch.span_collection.error.reason"]
        )
        assert "kept failing" in reason
        assert "connection refused" in reason

    @pytest.mark.asyncio
    async def test_a_poll_succeeding_after_a_failed_one_settles_the_trace(self):
        """@scenario A failed poll retries until the deadline instead of failing the trace"""
        api = FakeTraceApi(
            {
                TRACE_A: [
                    RuntimeError("transient blip"),
                    _trace_response(TRACE_A, [_api_span("a" * 16)]),
                ]
            }
        )
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)
        collector = JudgeSpanCollector()

        await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=60.0
        )

        names = _collected_names(collector, THREAD_ID)
        assert ERROR_SPAN_NAME not in names
        assert len(names) == 1

    @pytest.mark.asyncio
    async def test_a_failed_trace_never_gets_a_second_synthetic_span(self):
        api = FakeTraceApi({TRACE_A: [RuntimeError("boom")]})
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)
        collector = JudgeSpanCollector()

        await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=60.0
        )
        await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=60.0
        )

        assert _collected_names(collector, THREAD_ID) == [ERROR_SPAN_NAME]


class TestMergeFilterAndDedup:
    """@scenario Remote spans deduplicate against locally collected spans"""

    @pytest.mark.asyncio
    async def test_spans_already_collected_locally_are_not_added_twice(self):
        local_span_id = "a" * 16
        local_span = convert_api_span(
            _api_span(local_span_id, name="local llm call"),
            trace_id=TRACE_A,
            thread_id=THREAD_ID,
        )
        assert local_span is not None
        collector = JudgeSpanCollector()
        collector.on_end(local_span)

        remote = _trace_response(
            TRACE_A,
            [
                _api_span(local_span_id, name="local llm call"),
                _api_span("c" * 16, name="new remote span"),
            ],
        )
        api = FakeTraceApi({TRACE_A: [remote]})
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)

        await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=60.0
        )

        assert sorted(_collected_names(collector, THREAD_ID)) == [
            "local llm call",
            "new remote span",
        ]

    @pytest.mark.asyncio
    async def test_spans_merged_by_an_earlier_poll_are_not_added_twice(self):
        root = _api_span("f" * 16, name="agent request")
        child = _api_span("a" * 16, parent_id="f" * 16)
        # Poll one carries only the child (unresolved parent); poll two
        # repeats the child alongside the root. The child must merge once.
        api = FakeTraceApi(
            {
                TRACE_A: [
                    _trace_response(TRACE_A, [child]),
                    _trace_response(TRACE_A, [root, child]),
                ]
            }
        )
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)
        collector = JudgeSpanCollector()

        await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=60.0
        )

        assert sorted(_collected_names(collector, THREAD_ID)) == [
            "agent request",
            "call llm",
        ]

    @pytest.mark.asyncio
    async def test_scenario_infrastructure_spans_are_filtered_out(self):
        remote = _trace_response(
            TRACE_A,
            [
                _api_span("a" * 16, name="langwatch.scenario.run.started"),
                _api_span("b" * 16, name="langwatch.judge.verdict"),
                _api_span("c" * 16, name="langwatch.user_simulator.turn"),
                _api_span("d" * 16, name="agent tool call"),
            ],
        )
        api = FakeTraceApi({TRACE_A: [remote]})
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)
        collector = JudgeSpanCollector()

        await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=60.0
        )

        assert _collected_names(collector, THREAD_ID) == ["agent tool call"]

    @pytest.mark.asyncio
    async def test_clear_thread_removes_all_fetch_state(self):
        api = FakeTraceApi({TRACE_A: [_trace_response(TRACE_A, [_api_span("a" * 16)])]})
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)
        collector = JudgeSpanCollector()

        await fetcher.settle_traces(
            thread_id=THREAD_ID,
            trace_ids=[TRACE_A],
            collector=collector,
            timeout=60.0,
        )
        calls_after_first = len(api.calls)

        fetcher.clear_thread(THREAD_ID)

        # In production clear_thread runs alongside the collector's own
        # clear, so the second settle starts from a fresh collector too.
        await fetcher.settle_traces(
            thread_id=THREAD_ID,
            trace_ids=[TRACE_A],
            collector=JudgeSpanCollector(),
            timeout=60.0,
        )
        assert len(api.calls) == calls_after_first + 1, (
            "cleared state means the trace id is polled again"
        )


class TestProcessSpanRegistry:
    """@scenario Spans started by the scenario process never count as remote evidence"""

    @pytest.mark.asyncio
    async def test_echoed_process_spans_yield_the_no_agent_spans_reason(self):
        collector = JudgeSpanCollector()
        # The still-open turn span and two spans under it. The turn span
        # never reaches on_end, so the per-thread ancestor walk cannot claim
        # its descendants, and instrumented-SDK model calls carry no thread
        # id at all: only the on_start registry knows all three.
        for span_id in ("1" * 16, "2" * 16, "3" * 16):
            started = convert_api_span(
                _api_span(span_id), trace_id=TRACE_A, thread_id=THREAD_ID
            )
            assert started is not None
            collector.on_start(started)

        echoes = _trace_response(
            TRACE_A,
            [
                _api_span("2" * 16, name="_JudgeAgent.call", parent_id="1" * 16),
                _api_span("3" * 16, name="litellm.completion", parent_id="2" * 16),
            ],
        )
        api = FakeTraceApi({TRACE_A: [echoes]})
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)

        settled = await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=5.0
        )

        assert settled is False
        names = _collected_names(collector, THREAD_ID)
        assert names == [ERROR_SPAN_NAME], (
            "no echoed process span was merged as remote evidence"
        )
        [error_span] = collector.get_spans_for_thread(THREAD_ID)
        reason = str(
            dict(error_span.attributes or {})[
                "langwatch.span_collection.error.reason"
            ]
        )
        assert "no agent spans arrived" in reason
        assert "still incomplete" not in reason, (
            "process-span echoes must not read as a partially ingested trace"
        )

    @pytest.mark.asyncio
    async def test_a_leaked_agent_span_still_reports_the_trace_incomplete(self):
        collector = JudgeSpanCollector()
        turn_span = convert_api_span(
            _api_span("1" * 16), trace_id=TRACE_A, thread_id=THREAD_ID
        )
        assert turn_span is not None
        collector.on_start(turn_span)

        # A genuine agent span whose parent never arrives: the registry must
        # not swallow it, so the deadline reason stays "still incomplete".
        response = _trace_response(
            TRACE_A,
            [_api_span("2" * 16, name="agent prompt", parent_id="a" * 16)],
        )
        api = FakeTraceApi({TRACE_A: [response]})
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)

        settled = await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=5.0
        )

        assert settled is False
        names = _collected_names(collector, THREAD_ID)
        assert "agent prompt" in names
        error_span = next(
            s
            for s in collector.get_spans_for_thread(THREAD_ID)
            if s.name == ERROR_SPAN_NAME
        )
        reason = str(
            dict(error_span.attributes or {})[
                "langwatch.span_collection.error.reason"
            ]
        )
        assert "still incomplete" in reason


class TestProcessSpanRegistryCleanup:
    """@scenario A finished scenario releases its traces from the process-span registry"""

    @pytest.mark.asyncio
    async def test_clearing_the_thread_releases_the_claimed_traces(self):
        collector = JudgeSpanCollector()
        # A local echo whose span never ends: ended-span discovery cannot
        # find this trace at clear time, only the settle-wait's claim can.
        started = convert_api_span(
            _api_span("1" * 16), trace_id=TRACE_A, thread_id=THREAD_ID
        )
        assert started is not None
        collector.on_start(started)
        api = FakeTraceApi(
            {
                TRACE_A: [
                    _trace_response(
                        TRACE_A, [_api_span("1" * 16, name="_JudgeAgent.call")]
                    )
                ]
            }
        )
        fetcher = _make_fetcher(api, FakeClock())
        await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=5.0
        )
        trace_a = _hex_or_hashed_id(TRACE_A, bits=128)
        span_one = _hex_or_hashed_id("1" * 16, bits=64)
        assert collector.is_process_span(trace_a, span_one) is True

        collector.clear_spans_for_thread(THREAD_ID)

        assert collector.is_process_span(trace_a, span_one) is False

    def test_clearing_one_thread_keeps_another_threads_claims(self):
        collector = JudgeSpanCollector()
        span_a = convert_api_span(
            _api_span("1" * 16), trace_id=TRACE_A, thread_id=THREAD_ID
        )
        span_b = convert_api_span(
            _api_span("2" * 16, trace_id=TRACE_B), trace_id=TRACE_B, thread_id="thread-2"
        )
        assert span_a is not None and span_b is not None
        collector.on_start(span_a)
        collector.on_start(span_b)
        trace_a = _hex_or_hashed_id(TRACE_A, bits=128)
        trace_b = _hex_or_hashed_id(TRACE_B, bits=128)
        collector.claim_traces(THREAD_ID, [trace_a])
        collector.claim_traces("thread-2", [trace_b])

        collector.clear_spans_for_thread(THREAD_ID)

        assert collector.is_process_span(trace_a, _hex_or_hashed_id("1" * 16, bits=64)) is False
        assert collector.is_process_span(trace_b, _hex_or_hashed_id("2" * 16, bits=64)) is True


class TestExtendSettle:
    """@scenario The judge may wait once more when the traces are incomplete"""

    @pytest.mark.asyncio
    async def test_extend_settle_re_arms_the_failed_trace_and_retracts_the_error_span(
        self,
    ):
        root = _api_span("f" * 16, name="agent request")
        child = _api_span("a" * 16, name="query db", parent_id="f" * 16)
        api = FakeTraceApi({TRACE_A: [_trace_response(TRACE_A, [child])]})
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)
        collector = JudgeSpanCollector()

        settled = await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=5.0
        )
        assert settled is False
        assert ERROR_SPAN_NAME in _collected_names(collector, THREAD_ID)

        # The missing root arrives during the extra wait.
        api.queues[TRACE_A] = [_trace_response(TRACE_A, [root, child])]
        extended = await fetcher.extend_settle(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=5.0
        )

        assert extended is True
        names = _collected_names(collector, THREAD_ID)
        assert ERROR_SPAN_NAME not in names, (
            "a trace that settles during the extra wait loses its synthetic"
            " error span"
        )
        assert sorted(names) == ["agent request", "query db"]
        assert (
            fetcher.none_settled(thread_id=THREAD_ID, trace_ids=[TRACE_A]) is False
        )

    @pytest.mark.asyncio
    async def test_a_trace_failing_the_extension_gets_one_fresh_error_span(self):
        child = _api_span("a" * 16, name="query db", parent_id="f" * 16)
        api = FakeTraceApi({TRACE_A: [_trace_response(TRACE_A, [child])]})
        clock = FakeClock()
        fetcher = _make_fetcher(api, clock)
        collector = JudgeSpanCollector()

        settled = await fetcher.settle_traces(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=5.0
        )
        assert settled is False

        extended = await fetcher.extend_settle(
            thread_id=THREAD_ID, trace_ids=[TRACE_A], collector=collector, timeout=5.0
        )

        assert extended is False
        names = _collected_names(collector, THREAD_ID)
        assert names.count(ERROR_SPAN_NAME) == 1, (
            "the retracted span is replaced by exactly one fresh error span"
        )


class TestSpanConversion:
    """Span conversion exposes what the digest formatter and trace tools read."""

    def test_converts_ids_timestamps_attributes_and_thread_tag(self):
        span = convert_api_span(
            {
                "trace_id": TRACE_A,
                "span_id": "b" * 16,
                "parent_id": "c" * 16,
                "name": "query table",
                "type": "tool",
                "model": "openai/gpt-5-mini",
                "timestamps": {
                    "started_at": 1721382486895,
                    "finished_at": 1721382488392,
                },
                "input": {"type": "json", "value": {"table": "requirements"}},
                "output": {"type": "text", "value": "4 rows"},
                "metrics": {"prompt_tokens": 20, "completion_tokens": 7},
            },
            trace_id=TRACE_A,
            thread_id=THREAD_ID,
        )
        assert span is not None

        context = span.get_span_context()
        assert context is not None
        assert context.trace_id == int(TRACE_A, 16)
        assert context.span_id == int("b" * 16, 16)
        assert span.parent is not None
        assert span.parent.span_id == int("c" * 16, 16)
        assert span.name == "query table"
        assert span.start_time == 1721382486895 * 1_000_000
        assert span.end_time == 1721382488392 * 1_000_000

        attributes = dict(span.attributes or {})
        assert attributes["langwatch.thread.id"] == THREAD_ID
        assert attributes["langwatch.span.type"] == "tool"
        assert attributes["langwatch.input"] == '{"table": "requirements"}'
        assert attributes["langwatch.output"] == "4 rows"
        assert attributes["gen_ai.usage.input_tokens"] == 20
        assert attributes["gen_ai.usage.output_tokens"] == 7

    def test_non_hex_ids_map_to_stable_integers(self):
        span_one = convert_api_span(
            _api_span("span_h1xUkcUJilhudDrLeQbR_"),
            trace_id="trace_BKZL_X0TKSD4oa1aBJTc_",
            thread_id=THREAD_ID,
        )
        span_two = convert_api_span(
            _api_span("span_h1xUkcUJilhudDrLeQbR_"),
            trace_id="trace_BKZL_X0TKSD4oa1aBJTc_",
            thread_id=THREAD_ID,
        )
        assert span_one is not None and span_two is not None
        context_one = span_one.get_span_context()
        context_two = span_two.get_span_context()
        assert context_one is not None and context_two is not None
        assert context_one.span_id == context_two.span_id
        assert context_one.trace_id == context_two.trace_id

    def test_error_spans_carry_error_status_and_message(self):
        span = convert_api_span(
            {
                "trace_id": TRACE_A,
                "span_id": "d" * 16,
                "name": "failing call",
                "error": {"has_error": True, "message": "rate limited"},
            },
            trace_id=TRACE_A,
            thread_id=THREAD_ID,
        )
        assert span is not None
        assert span.status.status_code == StatusCode.ERROR
        assert span.status.description == "rate limited"
        assert dict(span.attributes or {})["error.message"] == "rate limited"

    def test_synthetic_error_span_matches_the_reference_shape(self):
        span = create_synthetic_error_span(
            trace_id=TRACE_A, thread_id=THREAD_ID, reason="timed out"
        )
        assert span.name == ERROR_SPAN_NAME
        assert span.parent is None
        assert span.start_time == span.end_time
        assert span.status.status_code == StatusCode.ERROR
        assert span.status.description == "timed out"
        attributes = dict(span.attributes or {})
        assert attributes["langwatch.span_collection.error"] is True
        assert attributes["langwatch.span_collection.error.reason"] == "timed out"
        context = span.get_span_context()
        assert context is not None
        assert context.trace_id == int(TRACE_A, 16)
