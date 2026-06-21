"""LangWatch tracing for live (production) OpenAI Realtime apps.

Scenario tests get rich LangWatch traces automatically via ``scenario.run()``,
but a production Realtime app gets nothing by default. ``RealtimeLangWatchSession``
(exported as ``realtime_langwatch_session``) wraps a live Realtime session in the
same per-turn span shape so live traffic lands in the same LangWatch project,
queryable alongside scenario-test traces.

Design constraints (issue #673):

- This module MUST NOT import from ``scenario._tracing.setup``. The setup module
  is the test-runner's lazy initialization path; the live helper has to stand on
  its own so it works in a process where ``scenario.run()`` was never called. The
  two small helpers it needs (``_get_concrete_provider`` /
  ``_add_langwatch_exporter``) are therefore intentionally duplicated inline.
- Importing ``scenario`` must NOT create a ``TracerProvider`` — all OTel work
  happens inside ``__aenter__``, never at import time.
- Nothing in the live path may raise into the host application. Export failures
  are swallowed and logged at WARNING.
"""

import logging
import os
from typing import Optional

from opentelemetry import context, trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SpanExporter

logger = logging.getLogger("scenario.tracing")


def _get_concrete_provider(provider) -> Optional[TracerProvider]:
    """Return the concrete ``TracerProvider`` if one exists, else ``None``.

    Checks the provider itself and one level of delegation (the
    ``ProxyTracerProvider`` pattern OTel uses before any provider is set).

    NOTE: intentionally duplicated from ``scenario._tracing.setup`` — see the
    module docstring for why this file must not import from setup.
    """
    if isinstance(provider, TracerProvider):
        return provider

    delegate = None
    if hasattr(provider, "get_delegate"):
        delegate = provider.get_delegate()
    elif hasattr(provider, "_delegate"):
        delegate = provider._delegate

    if isinstance(delegate, TracerProvider):
        return delegate

    return None


def _add_langwatch_exporter(provider: TracerProvider, api_key: str) -> None:
    """Attach the LangWatch OTLP exporter to ``provider``.

    Idempotent: does nothing if a LangWatch exporter is already attached to
    this provider instance (prevents duplicate processors on sequential sessions).

    Best-effort: if the OTLP HTTP exporter dependency is missing we log a
    warning and return rather than raising into the host app.

    NOTE: intentionally duplicated/simplified from ``scenario._tracing.setup``
    — see the module docstring for why this file must not import from setup.
    """
    if getattr(provider, "_scenario_langwatch_exporter_attached", False):
        return

    endpoint = os.environ.get("LANGWATCH_ENDPOINT", "https://app.langwatch.ai")

    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
    except ImportError:
        logger.warning(
            "opentelemetry-exporter-otlp-proto-http not installed. "
            "LangWatch span export disabled for realtime_langwatch_session."
        )
        return

    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    exporter: SpanExporter = OTLPSpanExporter(
        endpoint=f"{endpoint}/api/otel/v1/traces",
        headers={"Authorization": f"Bearer {api_key}"},
    )
    provider.add_span_processor(BatchSpanProcessor(exporter))
    setattr(provider, "_scenario_langwatch_exporter_attached", True)


class RealtimeLangWatchSession:
    """Async context manager that traces a live OpenAI Realtime session.

    Wrap your production Realtime loop in ``async with`` and call
    :meth:`log_turn` after each agent turn::

        from scenario import realtime_langwatch_session

        async with realtime_langwatch_session(
            name="my-production-session",
            model="gpt-4o-realtime-preview",
        ) as session:
            ...  # drive your raw Realtime WebSocket
            await session.log_turn(
                user_transcript="I want to cancel my subscription",
                agent_transcript="Of course, I can help with that.",
                model="gpt-4o-realtime-preview",
                latency_ms=430,
            )

    Behavior:

    - **No key → no-op.** If ``LANGWATCH_API_KEY`` is absent (and no ``api_key``
      is passed), entering the context and calling :meth:`log_turn` produce zero
      spans and never raise. Safe to ship in keyless environments.
    - **Fresh process.** If no concrete ``TracerProvider`` exists yet, one is
      created, wired to LangWatch, and installed globally; it is force-flushed on
      exit so spans are exported before the block returns.
    - **Existing provider.** If ``langwatch.setup()`` (or anything else) already
      installed a concrete provider, the helper attaches its exporter to that
      provider and leaves it in place — no duplicate initialization.
    - **Never raises into the host app.** Per-turn span failures are caught and
      logged at WARNING; ``__aexit__`` never raises.
    """

    def __init__(
        self,
        name: str = "realtime_session",
        *,
        model: Optional[str] = None,
        api_key: Optional[str] = None,
    ) -> None:
        self._name = name
        self._model = model
        self._api_key = api_key or os.environ.get("LANGWATCH_API_KEY")

        # Lifecycle flags.
        self._active = False  # is the context currently open (guards log_turn)?
        self._noop = False  # no key → emit nothing, but still guard log_turn

        # OTel handles, populated in __aenter__.
        self._provider: Optional[TracerProvider] = None
        self._own_provider = False  # did WE create/install the provider?
        self._tracer = None
        self._root_span = None
        self._ctx_token = None

    async def __aenter__(self) -> "RealtimeLangWatchSession":
        if not self._api_key:
            # No-op mode: the context is "active" (so log_turn does not raise the
            # not-active RuntimeError), but it emits nothing.
            self._noop = True
            self._active = True
            return self

        try:
            concrete = _get_concrete_provider(trace.get_tracer_provider())
            if concrete is None:
                # Fresh process — build and install our own provider.
                provider = TracerProvider()
                _add_langwatch_exporter(provider, self._api_key)
                trace.set_tracer_provider(provider)
                self._provider = provider
                self._own_provider = True
            else:
                # Attach to the provider someone else already installed.
                _add_langwatch_exporter(concrete, self._api_key)
                self._provider = concrete
                self._own_provider = False

            self._tracer = trace.get_tracer("scenario.realtime")
            self._root_span = self._tracer.start_span(self._name)
            if self._model is not None:
                self._root_span.set_attribute("model", self._model)
            self._ctx_token = context.attach(
                trace.set_span_in_context(self._root_span)
            )
        except Exception as exc:  # noqa: BLE001 - never raise into the host app
            logger.warning(
                "Failed to start realtime_langwatch_session root span; "
                "continuing as a no-op. (error type: %s)",
                type(exc).__name__,
            )
            self._noop = True

        self._active = True
        return self

    async def log_turn(
        self,
        user_transcript: str,
        agent_transcript: str,
        model: str,
        latency_ms: float,
    ) -> None:
        """Record one agent turn as a child LLM span under the root span.

        Raises:
            RuntimeError: if called before ``__aenter__`` or after ``__aexit__``.
                In no-op mode (no API key) this is a silent no-op instead.
        """
        if not self._active:
            raise RuntimeError(
                "realtime_langwatch_session context is not active — call "
                "async with realtime_langwatch_session() as session first"
            )

        if self._noop:
            return

        try:
            assert self._tracer is not None  # for type-checkers; guarded by _noop
            ctx = (
                trace.set_span_in_context(self._root_span)
                if self._root_span is not None
                else None
            )
            span = self._tracer.start_span("realtime_turn", context=ctx)
            span.set_attribute("type", "llm")
            span.set_attribute("input", user_transcript)
            span.set_attribute("output", agent_transcript)
            span.set_attribute("model", model)
            span.set_attribute("latency_ms", latency_ms)
            span.end()
        except Exception:  # noqa: BLE001 - export/processor failures must not propagate
            logger.warning(
                "Failed to record realtime turn span; dropping it.",
                exc_info=True,
            )

    async def __aexit__(self, exc_type, exc, tb) -> None:
        # Guard first so log_turn raises if called after exit.
        self._active = False

        try:
            if self._root_span is not None:
                self._root_span.end()
        except Exception:  # noqa: BLE001
            logger.warning(
                "Failed to end realtime_langwatch_session root span.", exc_info=True
            )

        try:
            if self._ctx_token is not None:
                context.detach(self._ctx_token)
        except Exception:  # noqa: BLE001
            logger.warning(
                "Failed to detach realtime_langwatch_session context.", exc_info=True
            )

        # Force-flush only the provider WE own, so spans export before returning.
        try:
            if self._own_provider and self._provider is not None:
                self._provider.force_flush()
        except Exception:  # noqa: BLE001
            logger.warning(
                "Failed to flush realtime_langwatch_session provider.", exc_info=True
            )

