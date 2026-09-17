/**
 * Mapping helpers: the words a test author writes to say where an evaluator
 * input reads from. Each helper is a function of the scenario state, the same
 * object a script step receives, and carries the expression it stands for.
 */
import type {
  EvaluatorMappingLiteral,
  ScenarioEvaluator,
  ScenarioExecutionStateLike,
} from "../domain";
import { messageText } from "../execution/state-views";

/** A mapping helper: a function of the state that names its expression. */
export type StateMapping = ((state: ScenarioExecutionStateLike) => unknown) & {
  /** The state expression the helper stands for, for example `state.field("golden_sql")`. */
  expression: string;
};

function sugar(
  expression: string,
  read: (state: ScenarioExecutionStateLike) => unknown
): StateMapping {
  return Object.assign(read, { expression });
}

/**
 * Inputs that read the conversation of the run.
 */
export const conversation = {
  /** `state.firstUserMessage() || undefined`: the text of the first message the simulated user sent. */
  firstUserMessage: sugar("state.firstUserMessage() || undefined", (state) => state.firstUserMessage() || undefined),
  /** `messageText(state.lastAgentMessage())`: the text of the last message the agent under test sent. */
  lastAgentMessage: sugar("messageText(state.lastAgentMessage())", (state) =>
    state.messages.some((message) => message.role === "assistant")
      ? messageText(state.lastAgentMessage())
      : undefined
  ),
  /** `state.transcript()`: the whole conversation as `role: content` lines. */
  transcript: sugar("state.transcript()", (state) => state.transcript()),
  /** `state.messages`: the whole conversation as a list of messages. */
  messages: sugar("state.messages", (state) => state.messages),
} as const;

/**
 * Inputs that read the scenario definition: its description or its criteria.
 */
export const scenarioSource = {
  /** `state.description`: the scenario description. */
  situation: sugar("state.description", (state) => state.description),
  /** `state.criteria.join("\n")`: the judge criteria, one per line. */
  criteria: sugar('state.criteria.join("\\n")', (state) => state.criteria.join("\n")),
} as const;

/**
 * `state.field(name)`: one field of the scenario, for example
 * `field("golden_sql")`. A scenario that leaves the field blank skips the
 * evaluator with the reason `no golden_sql on this scenario`.
 */
export function field(name: string): StateMapping {
  return sugar(`state.field(${JSON.stringify(name)})`, (state) => state.field(name));
}

/** The input and the output of one tool call pick. */
export interface ToolCallPick {
  /** The arguments of the call. */
  input: StateMapping;
  /** The result of the call. */
  output: StateMapping;
}

/** The picks and columns over the calls of one tool. */
export interface ToolCallsMapping {
  /** `state.toolCalls(name).first`: the first call of the tool. */
  first: ToolCallPick;
  /** `state.toolCalls(name).last`: the last call of the tool. */
  last: ToolCallPick;
  /** `state.toolCalls(name).inputs`: the arguments of every call. */
  inputs: StateMapping;
  /** `state.toolCalls(name).outputs`: the result of every call. */
  outputs: StateMapping;
}

/**
 * Inputs that read evidence from the traces of the run: retrieved contexts,
 * the spans, or the calls of a tool.
 */
export const trace = {
  /** `state.contexts`: every chunk the agent retrieved, across the run. */
  contexts: sugar("state.contexts", (state) => state.contexts),
  /** `state.spans`: every span of every trace of the run, in start order. */
  spans: sugar("state.spans", (state) => state.spans),
  /**
   * `state.toolCalls(name)`: the calls of one tool across the run, from the
   * assistant messages and the tool spans. `toolCalls("run_sql").last.input`
   * is the arguments of the last call; a run without that call skips the
   * evaluator with the reason `no run_sql call in the trace`.
   */
  toolCalls(name: string): ToolCallsMapping {
    const calls = `state.toolCalls(${JSON.stringify(name)})`;
    return {
      first: {
        input: sugar(`${calls}.first?.input`, (state) => state.toolCalls(name).first?.input),
        output: sugar(`${calls}.first?.output`, (state) => state.toolCalls(name).first?.output),
      },
      last: {
        input: sugar(`${calls}.last?.input`, (state) => state.toolCalls(name).last?.input),
        output: sugar(`${calls}.last?.output`, (state) => state.toolCalls(name).last?.output),
      },
      inputs: sugar(`${calls}.inputs`, (state) => state.toolCalls(name).inputs),
      outputs: sugar(`${calls}.outputs`, (state) => state.toolCalls(name).outputs),
    };
  },
} as const;

/**
 * An input that takes a literal value. A literal can also be written
 * directly in the mappings; the helper is for symmetry with the others.
 */
export function value(literal: EvaluatorMappingLiteral): StateMapping {
  return sugar(JSON.stringify(literal), () => literal);
}

/**
 * Attaches a LangWatch evaluator to a scenario run.
 *
 * @param evaluatorRef A built-in type such as `ragas/sql_query_equivalence`,
 *   or a saved evaluator as `evaluators/<slug>`.
 * @param options Whether the evaluator gates the run, its input mappings and
 *   its settings overrides. A mapping is a function of the scenario state or
 *   a literal. Unmapped inputs are inferred from their names.
 *
 * @example
 * ```typescript
 * scenario.evaluator("ragas/sql_query_equivalence", {
 *   required: true,
 *   mappings: {
 *     output: (state) => state.toolCalls("run_sql").last?.input,
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
