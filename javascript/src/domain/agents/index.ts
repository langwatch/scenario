import { CoreMessage } from "ai";
import { ScenarioExecutionStateLike } from "../core/execution";
import { ScenarioConfig } from "../scenarios";
import { AgentReturnTypes } from "./types/agent-return.types";
export * from "./types/agent-return.types";

export enum AgentRole {
  USER = "User",
  AGENT = "Agent",
  JUDGE = "Judge",
}

export const allAgentRoles = [
  AgentRole.USER,
  AgentRole.AGENT,
  AgentRole.JUDGE,
] as const;

/**
 * Input provided to an agent's `call` method.
 */
export interface AgentInput {
  /**
   * A unique identifier for the conversation thread.
   */
  threadId: string;
  /**
   * The full history of messages in the conversation.
   */
  messages: CoreMessage[];
  /**
   * New messages added since the last time this agent was called.
   */
  newMessages: CoreMessage[];
  /**
   * The role the agent is being asked to play in this turn.
   */
  requestedRole: AgentRole;
  /**
   * Whether a judgment is being requested in this turn.
   */
  judgmentRequest: boolean;
  /**
   * The current state of the scenario execution.
   */
  scenarioState: ScenarioExecutionStateLike;
  /**
   * The configuration for the current scenario.
   */
  scenarioConfig: ScenarioConfig;
}

/**
 * Interface for agents in the Scenario framework.
 *
 * Agents can be implemented as plain objects or classes. The interface requires
 * a readonly role (immutable) and a call method that processes conversation input.
 *
 * @example
 * ```typescript
 * const myAgent: Agent = {
 *   role: AgentRole.AGENT,
 *   async call(input: AgentInput): Promise<AgentReturnTypes> {
 *     const userMessage = input.messages.find(m => m.role === 'user');
 *     if (userMessage) {
 *       return `You said: ${userMessage.content}`;
 *     }
 *     return "Hello!";
 *   }
 * };
 * ```
 */
export interface Agent {
  /**
   * The role this agent plays in scenarios. Must be immutable.
   */
  readonly role: AgentRole;

  /**
   * Process the input and generate a response.
   *
   * This is the main method that your agent implementation must provide.
   * It receives structured information about the current conversation state
   * and must return a response in one of the supported formats.
   *
   * @param input AgentInput containing conversation history, thread context, and scenario state.
   * @returns The agent's response.
   */
  call(input: AgentInput): Promise<AgentReturnTypes>;
}

/**
 * @deprecated Use Agent interface instead. This type alias is kept for backwards compatibility.
 */
export type AgentAdapter = Agent;

/**
 * @deprecated Use Agent interface instead. Abstract classes are no longer needed.
 */
export abstract class UserSimulatorAgentAdapter implements Agent {
  readonly role: AgentRole = AgentRole.USER;
  abstract call(input: AgentInput): Promise<AgentReturnTypes>;
}

/**
 * @deprecated Use Agent interface instead. Abstract classes are no longer needed.
 */
export abstract class JudgeAgentAdapter implements Agent {
  readonly role: AgentRole = AgentRole.JUDGE;
  abstract criteria: string[];
  abstract call(input: AgentInput): Promise<AgentReturnTypes>;
}
