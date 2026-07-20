/**
 * Voice-adapter LangWatch/OTel span instrumentation (issues #770 / #771).
 *
 * TypeScript mirror of `python/scenario/voice/_telemetry.py`. Span *names* are
 * defined by the shared runtime + the executor loop; each adapter contributes
 * *attributes* onto those spans (disambiguated by `voice.adapter.class`), not a
 * parallel `voice.<vendor>.*` name hierarchy.
 *
 * Safety contract (load-bearing): span emission must NEVER break a voice run. A
 * real body/transport error still propagates and marks the span ERROR (the "why
 * did my run fail" signal). But `span.end()` is UNGUARDED in raw OTel /
 * `withActiveSpan` — a misbehaving `SpanProcessor.onEnd` throws from it, and at
 * the executor connect loop that would abort the whole run before the first
 * turn. `voiceSpan` guards `end()` and logs one WARNING (neither the OTel SDK
 * nor `diag` log this by default — it must come from our own logger).
 */

import {
  context,
  trace,
  SpanStatusCode,
  type Span,
} from "@opentelemetry/api";
import { Logger } from "../utils/logger";

const logger = new Logger("scenario.voice");
const TRACER_NAME = "@langwatch/scenario";

type AttrValue = string | number | boolean;

function applyAttributes(
  span: Span,
  attributes: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) {
      span.setAttribute(key, value as AttrValue);
    }
  }
}

/**
 * Run `fn` inside a guarded `scenario.voice` span.
 *
 * - Sets `langwatch.span.type=span` plus any non-nullish `attributes`.
 * - Becomes the active span (via `context.with`) so nested spans parent under
 *   it automatically — no parent is passed.
 * - A thrown error is recorded, sets the span ERROR, and is **re-thrown**.
 * - `span.end()` is wrapped: a processor/exporter failure is swallowed and
 *   logged WARNING, never propagated into the audio path.
 */
export async function voiceSpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = trace.getTracer(TRACER_NAME).startSpan(name);
  span.setAttribute("langwatch.span.type", "span");
  applyAttributes(span, attributes);
  const ctx = trace.setSpan(context.active(), span);
  try {
    const result = await context.with(ctx, () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    throw err;
  } finally {
    try {
      span.end();
    } catch (exportErr) {
      logger.warn(
        `voice: span '${name}' failed to export; dropping it (run continues)`,
        exportErr,
      );
    }
  }
}

/** The currently-active span, for adapters stamping attributes onto a span they did not open. */
export function currentSpan(): Span | undefined {
  return trace.getSpan(context.active());
}

/** Set non-nullish attributes on `span` if it is recording. Never throws. */
export function setSpanAttributes(
  span: Span | undefined,
  attributes: Record<string, unknown>,
): void {
  if (!span || !span.isRecording()) return;
  try {
    applyAttributes(span, attributes);
  } catch {
    // best-effort — telemetry must not break the caller
  }
}
