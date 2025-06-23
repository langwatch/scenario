import { CoreMessage, CoreToolMessage } from "ai";

/**
 * Represents the result of a scenario execution.
 */
export interface ScenarioResult {
  /**
   * Indicates whether the scenario was successful.
   */
  success: boolean;

  /**
   * The sequence of messages exchanged during the scenario.
   */
  messages: CoreMessage[];

  /**
   * The reasoning behind the scenario's outcome.
   */
  reasoning?: string;

  /**
   * A list of criteria that were successfully met.
   */
  passedCriteria: string[];

  /**
   * A list of criteria that were not met.
   */
  failedCriteria: string[];

  /**
   * The total time taken for the scenario execution in seconds.
   */
  totalTime?: number;

  /**
   * The time the agent spent processing during the scenario in seconds.
   */
  agentTime?: number;
}

/**
 * Defines the state of a scenario execution.
 */
export interface ScenarioExecutionStateLike {
  /**
   * The sequence of messages exchanged during the scenario.
   */
  messages: CoreMessage[];

  /**
   * The unique identifier for the execution thread.
   */
  threadId: string;

  /**
   * The current turn number in the scenario.
   */
  currentTurn: number;

  /**
   * Adds a message to the execution state.
   * @param message - The message to add.
   * @param agentCount - The total number of agents.
   * @param fromAgentIdx - The index of the agent sending the message.
   */
  addMessage(message: CoreMessage, agentCount?: number, fromAgentIdx?: number): void;

  /**
    * Retrieves pending messages for a specific agent.
    * @param agentIdx - The index of the agent.
    * @returns An array of pending messages.
    */
  getPendingMessages(agentIdx: number): CoreMessage[];

  /**
   * Clears pending messages for a specific agent.
   * @param agentIdx - The index of the agent.
   */
  clearPendingMessages(agentIdx: number): void;

  /**
   * Retrieves the last message from the execution state.
   * @returns The last message.
   */
  lastMessage(): CoreMessage;

  /**
   * Retrieves the last user message from the execution state.
   * @returns The last user message.
   */
  lastUserMessage(): CoreMessage;

  /**
   * Retrieves the last tool call message for a specific tool.
   * @param toolName - The name of the tool.
   * @returns The last tool call message.
   */
  lastToolCall(toolName: string): CoreToolMessage;

  /**
   * Checks if a tool call for a specific tool exists in the execution state.
   * @param toolName - The name of the tool.
   * @returns True if the tool call exists, false otherwise.
   */
  hasToolCall(toolName: string): boolean;
}
