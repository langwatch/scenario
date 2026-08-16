"""
Fetches remote traces from the LangWatch trace API for judge evaluation.

When ``fetch_remote_traces`` is enabled, the scenario propagates its trace
context to the agent under test (see ``AgentInput.propagation_headers``), the
agent's own system reports spans to LangWatch under the same trace ids, and
this module fetches those spans back so the judge can evaluate the agent's
internal behavior (tool calls, database writes, API calls) on real evidence.

Fetched spans convert to ``ReadableSpan`` objects, are filtered against
scenario infrastructure span names, deduplicated against locally collected
spans, and fed into the same ``JudgeSpanCollector`` the judge already reads,
so the trace digest and the expand_trace / grep_trace tools work unchanged.
"""

import asyncio
import hashlib
import json
import logging
import random
import string
import threading
import time
from dataclasses import dataclass, field
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    List,
    Optional,
    Sequence,
    Set,
)

import httpx
from langwatch.attributes import AttributeKey
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.util.instrumentation import InstrumentationScope
from opentelemetry.trace import SpanContext, SpanKind, TraceFlags
from opentelemetry.trace.status import Status, StatusCode

from scenario._events.event_reporter import _resolve_langwatch_client_api_key
from scenario.config import LangWatchSettings

from .judge_span_collector import JudgeSpanCollector


logger = logging.getLogger("scenario.tracing")


SETTLE_POLL_INTERVAL_SECONDS = 1.0
"""Seconds between polls while settle-waiting for a remote trace."""

DEFAULT_TRACE_WAIT_TIMEOUT_SECONDS = 60.0
"""Default shared budget for the verdict-time settle-wait, in seconds."""

ERROR_SPAN_NAME = "langwatch.span_collection.error"
"""Name of the synthetic span added when remote trace collection fails."""

INFRASTRUCTURE_SPAN_NAME_PREFIXES = (
    "langwatch.scenario.",
    "langwatch.judge.",
    "langwatch.user_simulator.",
)
"""Remote spans with these name prefixes are scenario infrastructure, not
agent behavior, and are dropped before reaching the judge."""

_INSTRUMENTATION_SCOPE = InstrumentationScope("langwatch.scenario")

TraceFetch = Callable[[str], Awaitable[Optional[Dict[str, Any]]]]
"""HTTP layer contract: given a trace id, return the trace API response body
as a dict, or None when the trace has not arrived yet (HTTP 404)."""


def _resolve_api_key() -> str:
    """API key resolution order: LANGWATCH_API_KEY env var, then the key set
    programmatically via ``langwatch.setup(api_key=...)``."""
    settings = LangWatchSettings()
    return settings.api_key or _resolve_langwatch_client_api_key()


async def _default_fetch_trace(trace_id: str) -> Optional[Dict[str, Any]]:
    """Fetches ``GET {LANGWATCH_ENDPOINT}/api/trace/{trace_id}``.

    Sends the API key on both ``Authorization: Bearer`` and ``X-Auth-Token``
    so it works across LangWatch deployments that accept either header.
    Returns None on 404 (trace not arrived yet); raises on other failures.
    """
    settings = LangWatchSettings()
    api_key = _resolve_api_key()
    if not api_key:
        raise RuntimeError(
            "No LangWatch API key configured (set LANGWATCH_API_KEY or call "
            "langwatch.setup(api_key=...)); cannot fetch remote traces"
        )

    endpoint = str(settings.endpoint).rstrip("/")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "X-Auth-Token": api_key,
    }
    if settings.project_id:
        headers["X-Project-Id"] = settings.project_id

    async with httpx.AsyncClient(follow_redirects=True) as client:
        response = await client.get(
            f"{endpoint}/api/trace/{trace_id}",
            headers=headers,
            timeout=httpx.Timeout(10.0),
        )
    if response.status_code == 404:
        return None
    response.raise_for_status()
    return response.json()


def _hex_or_hashed_id(value: str, *, bits: int) -> int:
    """Maps a LangWatch id string to a stable OpenTelemetry integer id.

    Ids that are already OpenTelemetry hex ids (32 hex chars for traces,
    16 for spans) parse to the same integer the local SDK uses, which is
    what makes deduplication against locally collected spans work. Any
    other id shape (for example ``span_...``) hashes deterministically.
    """
    text = value.strip().lower()
    if len(text) == bits // 4 and all(c in string.hexdigits for c in text):
        parsed = int(text, 16)
        if parsed:
            return parsed
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    return int.from_bytes(digest[: bits // 8], "big") or 1


def _epoch_ms_to_ns(value: Any) -> Optional[int]:
    """Converts an epoch-milliseconds API timestamp to nanoseconds."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value * 1_000_000)
    return None


def _io_value_to_attribute(io: Any) -> Optional[str]:
    """Renders a span input/output payload as a readable attribute string.

    The API shape is ``{"type": ..., "value": ...}``. Plain text values stay
    raw strings; anything else (chat messages, JSON) is JSON-encoded.
    """
    if not isinstance(io, dict):
        return None
    value = io.get("value")
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return str(value)


def convert_api_span(
    span_data: Dict[str, Any],
    *,
    trace_id: str,
    thread_id: str,
) -> Optional[ReadableSpan]:
    """Converts one LangWatch trace API span into a ``ReadableSpan``.

    Maps span_id / parent_id / trace_id to OpenTelemetry integer ids, epoch
    millisecond timestamps to nanoseconds, and type / input / output / error
    / metrics into span attributes the judge digest can render. Every
    converted span is tagged with ``langwatch.thread.id`` so the judge span
    collector can retrieve it for the scenario's thread.

    Returns None when the span has no usable span id.
    """
    span_id_raw = span_data.get("span_id")
    if not isinstance(span_id_raw, str) or not span_id_raw:
        return None

    span_trace_id = span_data.get("trace_id")
    effective_trace_id = (
        span_trace_id if isinstance(span_trace_id, str) and span_trace_id else trace_id
    )

    context = SpanContext(
        trace_id=_hex_or_hashed_id(effective_trace_id, bits=128),
        span_id=_hex_or_hashed_id(span_id_raw, bits=64),
        is_remote=True,
        trace_flags=TraceFlags(TraceFlags.SAMPLED),
    )

    parent: Optional[SpanContext] = None
    parent_id_raw = span_data.get("parent_id")
    if isinstance(parent_id_raw, str) and parent_id_raw:
        parent = SpanContext(
            trace_id=context.trace_id,
            span_id=_hex_or_hashed_id(parent_id_raw, bits=64),
            is_remote=True,
            trace_flags=TraceFlags(TraceFlags.SAMPLED),
        )

    attributes: Dict[str, Any] = {AttributeKey.LangWatchThreadId: thread_id}

    span_type = span_data.get("type")
    if isinstance(span_type, str) and span_type:
        attributes[AttributeKey.LangWatchSpanType] = span_type

    model = span_data.get("model")
    if isinstance(model, str) and model:
        attributes["gen_ai.request.model"] = model

    input_value = _io_value_to_attribute(span_data.get("input"))
    if input_value is not None:
        attributes[AttributeKey.LangWatchInput] = input_value
    output_value = _io_value_to_attribute(span_data.get("output"))
    if output_value is not None:
        attributes[AttributeKey.LangWatchOutput] = output_value

    metrics = span_data.get("metrics")
    if isinstance(metrics, dict):
        prompt_tokens = metrics.get("prompt_tokens")
        if isinstance(prompt_tokens, int):
            attributes[AttributeKey.GenAIUsageInputTokens] = prompt_tokens
        completion_tokens = metrics.get("completion_tokens")
        if isinstance(completion_tokens, int):
            attributes[AttributeKey.GenAIUsageOutputTokens] = completion_tokens

    params = span_data.get("params")
    if isinstance(params, dict) and params:
        try:
            attributes["langwatch.params"] = json.dumps(params)
        except (TypeError, ValueError):
            pass

    status = Status(StatusCode.UNSET)
    error = span_data.get("error")
    if isinstance(error, dict) and error.get("has_error"):
        message = error.get("message")
        description = message if isinstance(message, str) and message else "unknown error"
        status = Status(StatusCode.ERROR, description)
        attributes["error.message"] = description

    timestamps = span_data.get("timestamps")
    start_time = None
    end_time = None
    if isinstance(timestamps, dict):
        start_time = _epoch_ms_to_ns(timestamps.get("started_at"))
        end_time = _epoch_ms_to_ns(timestamps.get("finished_at"))

    name = span_data.get("name")
    if not isinstance(name, str) or not name:
        name = span_type if isinstance(span_type, str) and span_type else "span"

    return ReadableSpan(
        name=name,
        context=context,
        parent=parent,
        resource=Resource.get_empty(),
        attributes=attributes,
        events=(),
        kind=SpanKind.INTERNAL,
        status=status,
        start_time=start_time,
        end_time=end_time,
        instrumentation_scope=_INSTRUMENTATION_SCOPE,
    )


def create_synthetic_error_span(
    *,
    trace_id: str,
    thread_id: str,
    reason: str,
) -> ReadableSpan:
    """Creates the synthetic span that reports a span collection failure.

    Named ``langwatch.span_collection.error`` with ERROR status carrying the
    reason, so the judge's trace digest can distinguish "no spans available"
    from "span collection failed". Tagged with the thread id so the judge
    span collector retrieves it alongside the real spans.
    """
    now_ns = time.time_ns()
    context = SpanContext(
        trace_id=_hex_or_hashed_id(trace_id, bits=128),
        span_id=random.getrandbits(64) or 1,
        is_remote=True,
        trace_flags=TraceFlags(TraceFlags.SAMPLED),
    )
    return ReadableSpan(
        name=ERROR_SPAN_NAME,
        context=context,
        parent=None,
        resource=Resource.get_empty(),
        attributes={
            "langwatch.span_collection.error": True,
            "langwatch.span_collection.error.reason": reason,
            AttributeKey.LangWatchThreadId: thread_id,
        },
        events=(),
        kind=SpanKind.INTERNAL,
        status=Status(StatusCode.ERROR, reason),
        start_time=now_ns,
        end_time=now_ns,
        instrumentation_scope=_INSTRUMENTATION_SCOPE,
    )


@dataclass
class _TraceFetchState:
    """Per-trace-id fetch state kept for the duration of a scenario run."""

    settled: bool = False
    failed: bool = False
    merged_span_ids: Set[int] = field(default_factory=set)
    """Span ids this fetcher merged into the collector, i.e. the remote spans."""


class RemoteTraceFetcher:
    """
    Fetches remote traces from the LangWatch trace API and merges their spans
    into the judge span collector.

    A trace settles cleanly when it holds at least one remote span (a fetched
    span that is not one of the scenario's own locally collected spans) AND
    every fetched span's parent resolves within the fetched and locally
    collected spans: the trace is complete, because ancestors always finish
    and export after their descendants. Count-stability is deliberately NOT a
    settle signal: ingestion arrives in chunks that can be tens of seconds
    apart, and a stable early chunk would satisfy it while tool spans are
    still on the way.

    When the deadline expires with remote spans present but parents still
    unresolved, the trace settles best-effort: every span that arrived stays
    in the collector, plus one synthetic ``langwatch.span_collection.error``
    span marking the trace incomplete, so the judge can still pass criteria
    proven by the visible spans while treating the rest as inconclusive.
    When the deadline expires with no remote span at all (propagation broken,
    agent unreachable, agent not instrumented), the synthetic error span
    reports that nothing was collected.

    Keeps a per-thread-id registry of per-trace fetch state (merged span ids,
    settled flag), mirroring the judge span collector singleton pattern. The
    registry is cleared together with the collector when a scenario run
    finishes.

    The HTTP layer is injectable via ``fetch_trace`` for tests; ``sleep`` and
    ``monotonic`` are injectable so settle-wait timing is controllable.
    """

    def __init__(
        self,
        *,
        fetch_trace: Optional[TraceFetch] = None,
        sleep: Optional[Callable[[float], Awaitable[None]]] = None,
        monotonic: Optional[Callable[[], float]] = None,
    ) -> None:
        self._fetch_trace: TraceFetch = fetch_trace or _default_fetch_trace
        self._sleep = sleep or asyncio.sleep
        self._monotonic = monotonic or time.monotonic
        self._registry: Dict[str, Dict[str, _TraceFetchState]] = {}
        self._registry_lock = threading.Lock()

    # ------------------------------------------------------------- registry

    def _states_for_thread(self, thread_id: str) -> Dict[str, _TraceFetchState]:
        with self._registry_lock:
            return self._registry.setdefault(thread_id, {})

    def _state(self, thread_id: str, trace_id: str) -> _TraceFetchState:
        states = self._states_for_thread(thread_id)
        if trace_id not in states:
            states[trace_id] = _TraceFetchState()
        return states[trace_id]

    def clear_thread(self, thread_id: str) -> None:
        """Removes all fetch state for a scenario thread.

        Called when a scenario run completes, alongside
        ``JudgeSpanCollector.clear_spans_for_thread``, to prevent memory
        buildup in long-lived processes.
        """
        with self._registry_lock:
            self._registry.pop(thread_id, None)

    def has_unsettled_traces(
        self, *, thread_id: str, trace_ids: Sequence[str]
    ) -> bool:
        """Whether any of the given trace ids has neither settled nor failed."""
        states = self._states_for_thread(thread_id)
        for trace_id in trace_ids:
            state = states.get(trace_id)
            if state is None or (not state.settled and not state.failed):
                return True
        return False

    # ------------------------------------------------------------- fetching

    async def fetch_traces_once(
        self,
        *,
        thread_id: str,
        trace_ids: Sequence[str],
        collector: JudgeSpanCollector,
    ) -> None:
        """One non-blocking fetch round for ids that have not settled.

        A single request per trace id, all ids in parallel, no sleeping, no
        retry. A trace that already looks complete (parent-resolved with
        remote spans) settles here, so the verdict has nothing left to wait
        for. A trace that has not arrived yet (404) counts as zero spans.
        A transient failure is logged and leaves the trace eligible for the
        settle-wait at verdict time; it never raises.
        """

        async def fetch_one(trace_id: str) -> None:
            state = self._state(thread_id, trace_id)
            if state.settled or state.failed:
                return
            try:
                await self._poll_once(
                    thread_id=thread_id,
                    trace_id=trace_id,
                    state=state,
                    collector=collector,
                )
            except Exception as error:
                logger.debug(
                    "Non-blocking remote trace fetch failed for %s: %r",
                    trace_id,
                    error,
                )

        await asyncio.gather(*[fetch_one(trace_id) for trace_id in trace_ids])

    async def settle_traces(
        self,
        *,
        thread_id: str,
        trace_ids: Sequence[str],
        collector: JudgeSpanCollector,
        timeout: float,
    ) -> None:
        """Settle-waits for every unsettled trace id before a verdict.

        Polls each unsettled id every second until it settles (see the class
        docstring for the settle conditions), all ids in parallel, under one
        shared deadline of ``timeout`` seconds.

        On deadline expiry or a hard fetch failure the trace id is marked
        failed and one synthetic ``langwatch.span_collection.error`` span is
        added to the collector; this method never raises.
        """
        deadline = self._monotonic() + timeout
        pending = []
        for trace_id in trace_ids:
            state = self._state(thread_id, trace_id)
            if not state.settled and not state.failed:
                pending.append(trace_id)
        if not pending:
            return
        await asyncio.gather(
            *[
                self._settle_one(
                    thread_id=thread_id,
                    trace_id=trace_id,
                    collector=collector,
                    deadline=deadline,
                    timeout=timeout,
                )
                for trace_id in pending
            ]
        )

    async def _settle_one(
        self,
        *,
        thread_id: str,
        trace_id: str,
        collector: JudgeSpanCollector,
        deadline: float,
        timeout: float,
    ) -> None:
        state = self._state(thread_id, trace_id)
        last_remote_span_count = 0
        while True:
            try:
                last_remote_span_count = await self._poll_once(
                    thread_id=thread_id,
                    trace_id=trace_id,
                    state=state,
                    collector=collector,
                )
            except Exception as error:
                self._mark_failed(
                    thread_id=thread_id,
                    trace_id=trace_id,
                    state=state,
                    collector=collector,
                    reason=f"Failed to fetch remote trace {trace_id}: {error}",
                )
                return

            if state.settled:
                return

            if self._monotonic() >= deadline:
                if last_remote_span_count >= 1:
                    # Best-effort settle: the spans that arrived stay judged,
                    # and the error span tells the judge the trace may be
                    # missing spans.
                    self._mark_failed(
                        thread_id=thread_id,
                        trace_id=trace_id,
                        state=state,
                        collector=collector,
                        reason=(
                            f"Trace {trace_id} was still incomplete after "
                            f"{timeout:g}s: {last_remote_span_count} remote "
                            "spans were collected but some parent spans never "
                            "arrived, so spans may be missing"
                        ),
                    )
                else:
                    self._mark_failed(
                        thread_id=thread_id,
                        trace_id=trace_id,
                        state=state,
                        collector=collector,
                        reason=(
                            f"Timed out waiting for remote trace {trace_id} "
                            f"after {timeout:g}s: no agent spans arrived (the "
                            "agent may not have adopted the propagated trace "
                            "context or may not report to this LangWatch "
                            "project)"
                        ),
                    )
                return

            await self._sleep(
                min(SETTLE_POLL_INTERVAL_SECONDS, max(0.0, deadline - self._monotonic()))
            )

    async def _poll_once(
        self,
        *,
        thread_id: str,
        trace_id: str,
        state: _TraceFetchState,
        collector: JudgeSpanCollector,
    ) -> int:
        """One fetch + merge + settle evaluation.

        Marks the state settled when the trace holds at least one remote span
        and every fetched span's parent resolves (fetched or locally
        collected). Returns the remote span count of this poll.
        """
        trace_data = await self._fetch_trace(trace_id)
        spans_data: List[Dict[str, Any]] = []
        if isinstance(trace_data, dict):
            raw_spans = trace_data.get("spans")
            if isinstance(raw_spans, list):
                spans_data = [s for s in raw_spans if isinstance(s, dict)]

        remote_span_count, parents_resolved = self._merge_spans(
            spans_data,
            thread_id=thread_id,
            trace_id=trace_id,
            state=state,
            collector=collector,
        )

        if remote_span_count >= 1 and parents_resolved:
            state.settled = True
        return remote_span_count

    def _merge_spans(
        self,
        spans_data: List[Dict[str, Any]],
        *,
        thread_id: str,
        trace_id: str,
        state: _TraceFetchState,
        collector: JudgeSpanCollector,
    ) -> "tuple[int, bool]":
        """Converts, filters, deduplicates and feeds spans to the collector.

        Scenario infrastructure spans are dropped by name prefix. Span ids
        already present in the collector for this thread (the scenario's own
        spans, collected locally and also exported to LangWatch) and span ids
        merged by an earlier poll are skipped.

        Returns the remote-only span count (fetched spans that are not the
        scenario's own locally collected spans) and whether every fetched
        span's parent id resolves within the fetched spans plus the locally
        collected ones. Ancestors finish and export after their descendants,
        so unresolved parents mean the trace is still arriving. (Missing leaf
        subtrees are undetectable from the outside; the deadline bounds
        those.)
        """
        collector_span_ids: Set[int] = set()
        for local_span in collector.get_spans_for_thread(thread_id):
            span_context = local_span.get_span_context()
            if span_context:
                collector_span_ids.add(span_context.span_id)
        # The collector holds both the scenario's own spans and remote spans
        # merged by earlier polls; only the former count as local.
        local_span_ids = collector_span_ids - state.merged_span_ids

        fetched_span_ids: Set[int] = set()
        for span_data in spans_data:
            span_id_raw = span_data.get("span_id")
            if isinstance(span_id_raw, str) and span_id_raw:
                fetched_span_ids.add(_hex_or_hashed_id(span_id_raw, bits=64))

        remote_span_count = 0
        parents_resolved = len(spans_data) > 0

        for span_data in spans_data:
            parent_id_raw = span_data.get("parent_id")
            if isinstance(parent_id_raw, str) and parent_id_raw:
                parent_id = _hex_or_hashed_id(parent_id_raw, bits=64)
                if (
                    parent_id not in fetched_span_ids
                    and parent_id not in collector_span_ids
                ):
                    parents_resolved = False

            name = span_data.get("name")
            if isinstance(name, str) and name.startswith(
                INFRASTRUCTURE_SPAN_NAME_PREFIXES
            ):
                continue
            converted = convert_api_span(
                span_data, trace_id=trace_id, thread_id=thread_id
            )
            if converted is None:
                continue
            converted_context = converted.get_span_context()
            span_id = converted_context.span_id if converted_context else 0
            if span_id not in local_span_ids:
                remote_span_count += 1
            if span_id in local_span_ids or span_id in state.merged_span_ids:
                continue
            state.merged_span_ids.add(span_id)
            collector.on_end(converted)

        return remote_span_count, parents_resolved

    def _mark_failed(
        self,
        *,
        thread_id: str,
        trace_id: str,
        state: _TraceFetchState,
        collector: JudgeSpanCollector,
        reason: str,
    ) -> None:
        if state.failed:
            return
        state.failed = True
        logger.warning("Remote trace collection failed: %s", reason)
        collector.on_end(
            create_synthetic_error_span(
                trace_id=trace_id, thread_id=thread_id, reason=reason
            )
        )


# Singleton instance
remote_trace_fetcher = RemoteTraceFetcher()
