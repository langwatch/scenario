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
 * Core agent interface - this is the contract.
 * Any object implementing this interface can be used as an agent.
 *
 * @example
 * ```typescript
 * // Implement interface directly (duck typing)
 * const myAgent: IAgent = {
 *   role: AgentRole.AGENT,
 *   async call(input) {
 *     return `You said: ${input.messages.at(-1)?.content}`;
 *   }
 * };
 *
 * // Or extend base classes for convenience
 * class MyAgent extends UserSimulatorAgent {
 *   protected async invokeLLM(input: InvokeLLMInput) {
 *     // Override just the LLM call
 *   }
 * }
 * ```
 */
export interface IAgent {
  role: AgentRole;
  call(input: AgentInput): Promise<AgentReturnTypes>;
}

/**
 * Interface for user simulator agents.
 */
export interface IUserSimulatorAgent extends IAgent {
  role: AgentRole.USER;
}

/**
 * Interface for judge agents.
 */
export interface IJudgeAgent extends IAgent {
  role: AgentRole.JUDGE;
  criteria: string[];
}

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
 * @deprecated Use `IAgent` interface instead. This abstract class will be removed in v1.0.
 *
 * Abstract base class for integrating custom agents with the Scenario framework.
 * Prefer implementing `IAgent` interface directly or extending concrete base classes.
 *
 * @example
 * ```typescript
 * // NEW: Implement interface directly
 * const myAgent: IAgent = {
 *   role: AgentRole.AGENT,
 *   async call(input) {
 *     return `You said: ${input.messages.at(-1)?.content}`;
 *   }
 * };
 * ```
 */
export abstract class AgentAdapter implements IAgent {
  role: AgentRole = AgentRole.AGENT;

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
  abstract call(input: AgentInput): Promise<AgentReturnTypes>;
}

/**
 * @deprecated Use `IUserSimulatorAgent` interface or extend the new `UserSimulatorAgent` class.
 * This abstract class will be removed in v1.0.
 *
 * Abstract base class for user simulator agents.
 * User simulator agents are responsible for generating user messages to drive the conversation.
 */
export abstract class UserSimulatorAgentAdapter implements IUserSimulatorAgent {
  role: AgentRole.USER = AgentRole.USER;

  /**
   * Process the input and generate a user message.
   *
   * @param input AgentInput containing conversation history, thread context, and scenario state.
   * @returns The user's response.
   */
  abstract call(input: AgentInput): Promise<AgentReturnTypes>;
}

/**
 * @deprecated Use `IJudgeAgent` interface or extend the new `JudgeAgent` class.
 * This abstract class will be removed in v1.0.
 *
 * Abstract base class for judge agents.
 * Judge agents are responsible for evaluating the conversation and determining success or failure.
 */
export abstract class JudgeAgentAdapter implements IJudgeAgent {
  role: AgentRole.JUDGE = AgentRole.JUDGE;
  /**
   * The criteria the judge will use to evaluate the conversation.
   */
  abstract criteria: string[];

  /**
   * Process the input and evaluate the conversation.
   *
   * @param input AgentInput containing conversation history, thread context, and scenario state.
   * @returns A ScenarioResult if the conversation should end, otherwise should continue.
   */
  abstract call(input: AgentInput): Promise<AgentReturnTypes>;
}
