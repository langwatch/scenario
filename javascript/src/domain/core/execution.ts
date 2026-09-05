import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  AssistantModelMessage,
  ModelMessage,
  ToolModelMessage,
  UserModelMessage,
} from "ai";
import type {
  ToolCalls,
  TraceView,
  TurnView,
} from "../../execution/state-views";
import type {
  LatencyMetrics,
  VoiceEvent,
  VoiceRecording,
} from "../../voice/recording.types";
import type { ScenarioConfig } from "../scenarios";
import type { EvaluationResult, ScenarioFieldValue } from "./evaluations";

/**
 * Represents the result of a scenario execution.
 *
 */
export interface ScenarioResult {
  /**
   * Unique identifier for this scenario run.
   */
  runId: string;

  /**
   * Indicates whether the scenario was successful.
   */
  success: boolean;

  /**
   * The sequence of messages exchanged during the scenario.
   */
  messages: ModelMessage[];

  /**
   * The reasoning behind the scenario's outcome.
   */
  reasoning?: string;

  /**
   * A list of criteria that were successfully met.
   */
  metCriteria: string[];

  /**
   * A list of criteria that were not met.
   */
  unmetCriteria: string[];

  /**
   * The total time taken for the scenario execution in seconds.
   */
  totalTime?: number;

  /**
   * The time the agent spent processing during the scenario in seconds.
   */
  agentTime?: number;

  /**
   * An optional error message if the scenario failed due to an error.
   */
  error?: string;

  /**
   * One result per evaluator attached to the run. Present only when the
   * scenario declared evaluators.
   */
  evaluations?: EvaluationResult[];

  /**
   * Voice-only: the full audio record of the conversation, segmented by
   * speaker. Populated by the executor at end-of-scenario when a voice
   * adapter participated; absent for text-only runs (back-compat).
   */
  audio?: VoiceRecording;

  /**
   * Voice-only: timestamped events on the voice conversation timeline
   * (user_start_speaking, agent_start_speaking, user_interrupt, etc.).
   * Absent for text-only runs (back-compat).
   */
  timeline?: VoiceEvent[];

  /**
   * Voice-only: aggregate response-time statistics across the agent's
   * turns. Absent for text-only runs (back-compat).
   */
  latency?: LatencyMetrics;
}

/**
 * Defines the state of a scenario execution.
 */
export interface ScenarioExecutionStateLike {
  /**
   * The scenario configuration.
   */
  readonly config: ScenarioConfig;

  /**
   * The scenario description.
   */
  readonly description: string;

  /**
   * The sequence of messages exchanged during the scenario.
   */
  get messages(): ModelMessage[];

  /**
   * The unique identifier for the execution thread.
   */
  get threadId(): string;

  /**
   * The current turn number in the scenario.
   */
  get currentTurn(): number;

  /**
   * Adds a message to the scenario's execution state.
   *
   * @param message - The core message to add.
   */
  addMessage(message: ModelMessage): void;

  /**
   * Retrieves the last message from the execution state.
   * @returns The last message.
   */
  lastMessage(): ModelMessage;

  /**
   * Retrieves the last user message from the execution state.
   * @returns The last user message.
   */
  lastUserMessage(): UserModelMessage;

  /**
   * Retrieves the last agent message from the execution state.
   * @returns The last agent message.
   */
  lastAgentMessage(): AssistantModelMessage;

  /**
   * Retrieves the last tool call message for a specific tool.
   * @param toolName - The name of the tool.
   * @returns The last tool call message.
   */
  lastToolCall(toolName: string): ToolModelMessage;

  /**
   * Checks if a tool call for a specific tool exists in the execution state.
   * @param toolName - The name of the tool.
   * @returns True if the tool call exists, false otherwise.
   */
  hasToolCall(toolName: string): boolean;

  /**
   * The fields the scenario carries next to its description, its data row.
   */
  readonly fields: Record<string, ScenarioFieldValue>;

  /**
   * One field of the scenario. Nothing when the scenario does not set it or
   * leaves it blank; `0` and `false` are values.
   */
  field(name: string): ScenarioFieldValue | undefined;

  /**
   * The judge criteria of the scenario, in order.
   */
  readonly criteria: string[];

  /**
   * The text of the first message the simulated user sent, or an empty
   * string before the first user message.
   */
  firstUserMessage(): string;

  /**
   * The conversation so far as one `role: content` line per message.
   */
  transcript(): string;

  /**
   * Every call of a tool across the run so far, in start order, merged from
   * the tool calls of the assistant messages and the tool spans of the
   * traces. `toolCalls("run_sql").last?.input` is the arguments of the last
   * call. Without a name, every tool call of the run.
   */
  toolCalls(name?: string): ToolCalls;

  /**
   * Every chunk the agent retrieved across the run so far, from the rag
   * spans of the traces.
   */
  readonly contexts: string[];

  /**
   * Every span of every trace of the run collected so far, in start order.
   * Never fetches: a script step reads what the collector holds.
   */
  readonly spans: ReadableSpan[];

  /**
   * One entry per trace id the messages carry, in first-seen order.
   */
  readonly traces: TraceView[];

  /**
   * One entry per turn, with the messages added during it.
   */
  readonly turns: TurnView[];

  /**
   * Remove all messages from position `index` onward.
   *
   * Truncates the message list and cleans up any pending message queues
   * so no agent sees stale messages.
   *
   * @param index - Truncate point (clamped to `[0, messages.length]`).
   *   Messages at positions >= index are removed.
   * @returns The removed messages (empty array if nothing to remove).
   * @throws {RangeError} If `index` is negative.
   */
  rollbackMessagesTo(index: number): ModelMessage[];
}
