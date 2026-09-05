/**
 * Resolves one evaluator mapping against the scenario state: calls the
 * mapping with the state, awaits it, and reports what it read and what it
 * found missing.
 */
import type { EvaluatorMapping, ScenarioExecutionStateLike } from "../domain";
import type { StateReads } from "../execution/state-views";

/** The state the evaluator runner resolves mappings against. */
export interface EvaluatorState extends ScenarioExecutionStateLike {
  startReadTracking(): void;
  takeReads(): StateReads;
}

/**
 * How one mapping resolved. `nothing` carries the reason the evaluator
 * reports instead of running and whether the mapping read the trace, so the
 * runner may fetch the remote traces and call it again. `error` carries what
 * the mapping threw.
 */
export type ResolvedInput =
  | { kind: "value"; value: unknown }
  | { kind: "nothing"; reason: string; readTrace: boolean }
  | { kind: "error"; error: Error };

/** True for the values a mapping returns to say it found nothing. */
export function isNothing(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function reasonFor(reads: StateReads): string {
  const [blankField] = reads.blankFields;
  if (blankField !== undefined) return `no ${blankField} on this scenario`;
  const [missingToolCall] = reads.missingToolCalls;
  if (missingToolCall !== undefined) return `no ${missingToolCall} call in the trace`;
  if (reads.emptyContexts) return "no retrieved contexts in the trace";
  return "the mapping returned nothing";
}

/**
 * Calls the mapping with the state. A literal resolves to itself.
 */
export async function resolveMapping({
  mapping,
  state,
}: {
  mapping: EvaluatorMapping;
  state: EvaluatorState;
}): Promise<ResolvedInput> {
  if (typeof mapping !== "function") return { kind: "value", value: mapping };
  state.startReadTracking();
  let value: unknown;
  try {
    value = await mapping(state);
  } catch (error) {
    state.takeReads();
    return { kind: "error", error: error instanceof Error ? error : new Error(String(error)) };
  }
  const reads = state.takeReads();
  if (isNothing(value)) {
    return { kind: "nothing", reason: reasonFor(reads), readTrace: reads.trace };
  }
  return { kind: "value", value };
}
