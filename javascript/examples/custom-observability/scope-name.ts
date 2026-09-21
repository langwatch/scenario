import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

/** The two shapes OTel has used for the instrumentation scope, across SDK majors. */
type ScopedSpan = ReadableSpan & {
  instrumentationScope?: { name?: string };
  instrumentationLibrary?: { name?: string };
};

/**
 * Returns the instrumentation scope name for a span, handling both
 * OTel SDK v1 (instrumentationLibrary) and v2 (instrumentationScope).
 *
 * Shared rather than copied into each probe: this is a version-compatibility
 * shim, and the copy nobody remembers to update is the one that breaks when
 * OTel renames the field again.
 */
export function getScopeName(span: ReadableSpan): string {
  const s = span as ScopedSpan;
  return (
    s.instrumentationScope?.name ?? s.instrumentationLibrary?.name ?? "unknown"
  );
}
