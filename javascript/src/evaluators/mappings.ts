/**
 * Mapping helpers: the words a test author writes to say where an evaluator
 * input reads from. Each helper builds the mapping shape the platform stores.
 */
import type {
  EvaluatorMapping,
  EvaluatorMappingSourceId,
  ScenarioEvaluator,
} from "../domain";

function source(
  sourceId: EvaluatorMappingSourceId,
  path: string[]
): EvaluatorMapping {
  return { type: "source", sourceId, path };
}

/**
 * Inputs that read the conversation of the run.
 */
export const conversation = {
  /** The first message the simulated user sent. */
  firstUserMessage: source("conversation", ["first_user_message"]),
  /** The last message the agent under test sent. */
  lastAgentMessage: source("conversation", ["last_agent_message"]),
  /** The whole conversation as `role: content` lines. */
  transcript: source("conversation", ["transcript"]),
  /** The whole conversation as a JSON list of messages. */
  messages: source("conversation", ["messages"]),
} as const;

/**
 * Inputs that read the scenario definition: its description, its criteria
 * or one of its fields.
 */
export const scenarioSource = {
  /** The scenario description. */
  situation: source("scenario", ["situation"]),
  /** The judge criteria, one per line. */
  criteria: source("scenario", ["criteria"]),
} as const;

/**
 * An input that reads one field of the scenario, for example
 * `field("golden_sql")`. A scenario that leaves the field blank skips the
 * evaluator with a reason.
 */
export function field(name: string): EvaluatorMapping {
  return source("scenario", ["fields", name]);
}

/**
 * An input that reads evidence from the trace of the run: retrieved
 * contexts, or the input or output of a tool call.
 */
export const trace = {
  /** The contexts retrieved by the agent, concatenated. */
  contexts: source("trace", ["contexts"]),
  /**
   * The last call to a tool, for example `trace.toolCall("run_sql").input`.
   * A run without that call fails the evaluator with a reason.
   */
  toolCall(name: string): { input: EvaluatorMapping; output: EvaluatorMapping } {
    return {
      input: source("trace", ["tool_calls", name, "input"]),
      output: source("trace", ["tool_calls", name, "output"]),
    };
  },
} as const;

/**
 * An input that takes a literal value.
 */
export function value(literal: string): EvaluatorMapping {
  return { type: "value", value: literal };
}

/**
 * Attaches a LangWatch evaluator to a scenario run.
 *
 * @param evaluatorRef A built-in type such as `ragas/sql_query_equivalence`,
 *   or a saved evaluator as `evaluators/<slug>`.
 * @param options Whether the evaluator gates the run, its input mappings and
 *   its settings overrides. Unmapped inputs are inferred from their names.
 *
 * @example
 * ```typescript
 * scenario.evaluator("ragas/sql_query_equivalence", {
 *   required: true,
 *   mappings: {
 *     output: scenario.trace.toolCall("run_sql").input,
 *     expected_output: scenario.field("golden_sql"),
 *   },
 * });
 * ```
 */
export function evaluator(
  evaluatorRef: string,
  options: Omit<ScenarioEvaluator, "evaluator"> = {}
): ScenarioEvaluator {
  if (!evaluatorRef) {
    throw new Error("An evaluator reference is required");
  }
  return { evaluator: evaluatorRef, ...options };
}
