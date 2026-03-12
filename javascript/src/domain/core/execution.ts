import {
  AssistantModelMessage,
  ModelMessage,
  ToolModelMessage,
  UserModelMessage,
} from "ai";
import type { ScenarioConfig } from "../scenarios";

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
