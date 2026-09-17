/**
 * Evaluators on scenario runs: the mapping type, the evaluator attachment and
 * the result one evaluator produces. A mapping is a function of the scenario
 * state, so an evaluator reads the run through the same object a script step
 * does.
 */

import type { ScenarioExecutionStateLike } from "./execution";

/** A literal an evaluator input takes as a constant. */
export type EvaluatorMappingLiteral = string | number | boolean;

/**
 * Where one evaluator input reads its value from: a function of the scenario
 * state, the same object a script step receives, sync or async; or a literal.
 *
 * The function runs once the scenario has a verdict. What it returns is the
 * input value. Returning nothing (`undefined`, `null` or an empty list) skips
 * the evaluator; throwing reports an error result.
 *
 * @example
 * ```typescript
 * mappings: {
 *   output: (state) => state.toolCalls("run_sql").last?.input,
 *   expected_output: (state) => state.field("golden_sql"),
 *   contexts: (state) => state.spans.filter((span) => span.attributes["langwatch.span.type"] === "rag"),
 *   language: "en",
 * }
 * ```
 */
export type EvaluatorMapping =
  | EvaluatorMappingLiteral
  | ((state: ScenarioExecutionStateLike) => unknown);

/**
 * One evaluator attached to a scenario run.
 */
export interface ScenarioEvaluator {
  /**
   * The evaluator to run: a built-in type such as `ragas/sql_query_equivalence`
   * or a saved evaluator as `evaluators/<slug>`, the same reference the
   * evaluate endpoint accepts.
   */
  evaluator: string;
  /**
   * Whether a failing verdict fails the scenario. Defaults to true for an
   * evaluator that answers pass or fail, and to false for a score-only one.
   * A score never fails the scenario, whatever this flag says.
   */
  required?: boolean;
  /**
   * Where each evaluator input reads from, keyed by input name: a function of
   * the scenario state or a literal. An input without a mapping is inferred
   * from its name; a tool call is never inferred.
   */
  mappings?: Record<string, EvaluatorMapping>;
  /**
   * Per-run overrides of the evaluator settings.
   */
  settings?: Record<string, unknown>;
}

export const EVALUATION_STATUSES = [
  "passed",
  "failed",
  "scored",
  "skipped",
  "error",
] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

/**
 * The result of one evaluator on a scenario run. Field names match the
 * `results.evaluations` entries of the run finished event.
 */
export interface EvaluationResult {
  /** The saved evaluator id, or the evaluator type when run by type. */
  evaluatorId: string;
  name: string;
  status: EvaluationStatus;
  required: boolean;
  passed?: boolean;
  score?: number;
  label?: string;
  /**
   * The reason: judge details, "no golden_sql on this scenario", "no run_sql
   * call in the trace", "the mapping returned nothing", or the error.
   */
  details?: string;
  cost?: { currency: string; amount: number };
  /** The resolved input values, each cut to 2000 characters. */
  inputs?: Record<string, string>;
}

/** A field value a scenario carries next to its description. */
export type ScenarioFieldValue = string | number | boolean;
