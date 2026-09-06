import { context, propagation } from "@opentelemetry/api";

/**
 * Builds W3C trace context headers from the active OpenTelemetry context.
 *
 * Injects the active context into a fresh carrier via the globally registered
 * propagator, producing `traceparent` (and `tracestate` when set). Returns an
 * empty object when no span is active or no propagator is registered.
 *
 * Used to populate {@link AgentInput.propagationHeaders} inside the per-agent
 * call span, so the injected traceparent carries the same trace id that is
 * stamped on the turn's messages.
 */
export function buildPropagationHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}
