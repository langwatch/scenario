/**
 * Evaluators on scenario runs: the mapping shape, the evaluator attachment
 * and the result one evaluator produces. The mapping shape is the one the
 * LangWatch platform stores on a test suite, so a scenario defined in code
 * and a scenario defined on the platform describe the same thing.
 */

export const EVALUATOR_MAPPING_SOURCE_IDS = [
  "conversation",
  "scenario",
  "trace",
] as const;
export type EvaluatorMappingSourceId =
  (typeof EVALUATOR_MAPPING_SOURCE_IDS)[number];

/**
 * Where one evaluator input reads its value from.
 *
 * Source paths:
 * - conversation: `["first_user_message"]`, `["last_agent_message"]`,
 *   `["transcript"]` or `["messages"]`
 * - scenario: `["situation"]`, `["criteria"]` or `["fields", <name>]`
 * - trace: `["contexts"]` or `["tool_calls", <tool name>, "input" | "output"]`
 */
export type EvaluatorMapping =
  | {
      type: "source";
      sourceId: EvaluatorMappingSourceId;
      path: string[];
    }
  | { type: "value"; value: string };

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
   * Where each evaluator input reads from, keyed by input name. An input
   * without a mapping is inferred from its name; a tool call is never
   * inferred.
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
  /** The reason: judge details, "no golden_sql on this scenario", "no run_sql call in the trace". */
  details?: string;
  cost?: { currency: string; amount: number };
  /** The resolved input values, each cut to 2000 characters. */
  inputs?: Record<string, string>;
}

/** A field value a scenario carries next to its description. */
export type ScenarioFieldValue = string | number | boolean;
