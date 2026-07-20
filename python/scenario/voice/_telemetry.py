"""Voice-adapter LangWatch/OTel span instrumentation (issues #770 / #771).

Span *names* are defined by the shared base adapter + the executor loop; each
concrete adapter contributes *attributes* onto those same spans (disambiguated
by ``voice.adapter.class``) rather than a parallel ``voice.<vendor>.*`` name
hierarchy. This keeps cross-adapter queries uniform.

**Safety contract (load-bearing):** span emission must NEVER break a voice run.
A real body/transport exception still propagates and marks the span ERROR (that
is the "why did my run fail" signal we want). But a misbehaving
``SpanProcessor.on_end`` — which raises from ``span.end()`` — must be swallowed,
because the raw-OTel ``start_as_current_span`` / ``use_span`` context manager
runs ``finally: span.end()`` *unguarded*, so an unguarded end at the executor
connect loop would abort the whole run before the first turn. ``voice_span``
guards ``span.end()`` and logs one WARNING via the ``scenario.voice`` logger
(neither the OTel SDK nor LangWatch log this by default). Mirrors the defensive
pattern in ``scenario._tracing.live``.

Tracing itself is auto-activated by ``scenario.run()`` (``ensure_tracing_initialized``
runs before the first turn), so these spans appear during a normal run with zero
user setup; outside a run (a unit test calling ``.call()`` directly) the tracer
is a no-op unless the test installs its own provider.
"""

from __future__ import annotations

import contextlib
import logging
from typing import Any, Dict, Iterator, Optional

from opentelemetry import context, trace
from opentelemetry.trace import Span, Status, StatusCode

logger = logging.getLogger("scenario.voice")

_TRACER_NAME = "scenario.voice"


def _tracer():
    """Resolve the ``scenario.voice`` tracer against the CURRENT provider.

    Acquired per-call, not cached at module level: the OTel ``ProxyTracer``
    returned before a concrete provider is installed caches its first real
    delegate, which would pin every span to whichever provider happened to be
    active at import time — wrong under ``scenario.run()`` re-init and fatal for
    per-test ``InMemorySpanExporter`` providers. Mirrors ``_tracing.live``
    acquiring its tracer inside ``__aenter__`` rather than at import.
    """
    return trace.get_tracer(_TRACER_NAME)


@contextlib.contextmanager
def voice_span(
    name: str,
    attributes: Optional[Dict[str, Any]] = None,
    *,
    parent: Optional[context.Context] = None,
) -> Iterator[Span]:
    """Open a guarded ``scenario.voice`` span.

    - Sets ``langwatch.span.type=span`` plus any non-``None`` ``attributes``.
    - Becomes the current span so nested ``voice_span``/framework spans parent
      under it automatically (ambient OTel context when ``parent`` is ``None``).
    - ``parent`` pins the span under an EXPLICIT OTel context instead of the
      ambient one — the seam a background-receive-loop adapter (Pipecat, Twilio)
      uses to parent detached-task recv spans under the live ``voice.turn`` the
      base ``call()`` published, rather than the loop's frozen connect-time
      context (#774). ``None`` preserves the original ambient-nesting behaviour.
    - A body exception is recorded, sets the span ERROR, and is **re-raised**
      (a transport error must surface).
    - ``span.end()`` is wrapped: a processor/exporter failure is swallowed and
      logged WARNING, never propagated into the audio path.
    """
    span = _tracer().start_span(name, context=parent)
    span.set_attribute("langwatch.span.type", "span")
    for key, value in (attributes or {}).items():
        if value is not None:
            span.set_attribute(key, value)
    token = context.attach(trace.set_span_in_context(span, parent))
    try:
        yield span
    except BaseException as exc:  # noqa: BLE001 - mark + re-raise, never swallow the body
        span.record_exception(exc)
        span.set_status(Status(StatusCode.ERROR, type(exc).__name__))
        raise
    else:
        span.set_status(Status(StatusCode.OK))
    finally:
        context.detach(token)
        try:
            span.end()  # raw-OTel span.end() is UNGUARDED — a bad processor raises here
        except Exception:  # noqa: BLE001 - telemetry infra failure must not break the run
            logger.warning(
                "voice: span %r failed to export; dropping it (run continues)",
                name,
                exc_info=True,
            )


def set_span_attributes(span: Optional[Span], attributes: Dict[str, Any]) -> None:
    """Set non-``None`` attributes on ``span`` if it is recording.

    Convenience for adapters that add vendor attributes onto a base span they
    did not open (e.g. ElevenLabs stamping ``voice.elevenlabs.agent_id`` onto the
    active ``voice.adapter.connect`` span). Never raises.
    """
    if span is None or not span.is_recording():
        return
    for key, value in attributes.items():
        if value is not None:
            try:
                span.set_attribute(key, value)
            except Exception:  # noqa: BLE001
                logger.debug("voice: failed to set span attribute %r", key, exc_info=True)
