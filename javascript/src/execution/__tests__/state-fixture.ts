/**
 * Builds a scenario execution state for tests: messages stamped with a turn
 * and a trace id, fields, judge criteria and the spans the state reads.
 */
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { ModelMessage } from "ai";
import {
  AgentRole,
  JudgeAgentAdapter,
  type AgentInput,
  type ScenarioFieldValue,
} from "../../domain";
import { ScenarioExecutionState } from "../scenario-execution-state";

class CriteriaJudge extends JudgeAgentAdapter {
  constructor(public criteria: string[]) {
    super();
  }
  async call(_input: AgentInput) {
    return null;
  }
}

/** A message with the turn and the trace id the executor stamps on it. */
export type StampedMessage = ModelMessage & { traceId?: string; turn?: number };

export function span({
  name,
  attributes,
  traceId = "trace-1",
  startMs = 0,
}: {
  name: string;
  attributes: Record<string, unknown>;
  traceId?: string;
  startMs?: number;
}): ReadableSpan {
  return {
    name,
    attributes,
    startTime: [Math.floor(startMs / 1000), (startMs % 1000) * 1_000_000],
    spanContext: () => ({ traceId, spanId: `${name}-${startMs}`, traceFlags: 1 }),
  } as unknown as ReadableSpan;
}

export function stateWith({
  messages = [],
  fields = {},
  criteria = [],
  spans = [],
  description = "A fraud analyst asks for chargebacks.",
}: {
  messages?: StampedMessage[];
  fields?: Record<string, ScenarioFieldValue>;
  criteria?: string[];
  spans?: ReadableSpan[];
  description?: string;
} = {}): ScenarioExecutionState {
  const state = new ScenarioExecutionState({
    name: "chargebacks",
    description,
    agents: [
      { role: AgentRole.AGENT, call: async () => "" },
      new CriteriaJudge(criteria),
    ],
    fields,
  });
  state.setSpanProvider(() => spans);
  for (const message of messages) {
    const { turn, ...rest } = message;
    state.currentTurn = turn ?? 1;
    state.addMessage(rest);
  }
  return state;
}

export const SQL_INPUT = { sql: "SELECT count(*) FROM chargebacks" };

/** A user question, a run_sql tool call with its result, and the answer. */
export const messagesWithToolCall: StampedMessage[] = [
  { role: "user", content: "How many chargebacks last quarter?", traceId: "trace-1", turn: 1 },
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call_1", toolName: "run_sql", input: SQL_INPUT }],
    traceId: "trace-1",
    turn: 1,
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "run_sql",
        output: { type: "json", value: { count: 12 } },
      },
    ],
    traceId: "trace-1",
    turn: 1,
  },
  { role: "assistant", content: "There were 12 chargebacks.", traceId: "trace-1", turn: 1 },
];
