import { CoreMessage } from "ai";
import { ScenarioExecutionStateLike, ScenarioResult } from "../core/execution";
import { ScenarioConfig } from "../scenarios";

export enum AgentRole {
  USER = "User",
  AGENT = "Agent",
  JUDGE = "Judge",
}

export const allAgentRoles = [AgentRole.USER, AgentRole.AGENT, AgentRole.JUDGE] as const;

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
 * The possible return types from an agent's `call` method.
 * Can be a simple string, a single message, an array of messages, or a ScenarioResult.
 */
export type AgentReturnTypes = string | CoreMessage | CoreMessage[] | ScenarioResult;

/**
 * Abstract base class for integrating custom agents with the Scenario framework.
 *
 * This adapter pattern allows you to wrap any existing agent implementation
 * (LLM calls, agent frameworks, or complex multi-step systems) to work with
 * the Scenario testing framework. The adapter receives structured input about
 * the conversation state and returns responses in a standardized format.
 *
 * @example
 * ```typescript
 * class MyAgent extends AgentAdapter {
 *   role = AgentRole.AGENT;
 *
 *   async call(input: AgentInput): Promise<AgentReturnTypes> {
 *     const userMessage = input.messages.find(m => m.role === 'user');
 *     if (userMessage) {
 *       return `You said: ${userMessage.content}`;
 *     }
 *     return "Hello!";
 *   }
 * }
 * ```
 */
export abstract class AgentAdapter {
  role: AgentRole = AgentRole.AGENT;

  constructor(input: AgentInput) {
    void input;
  }

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
 * Abstract base class for user simulator agents.
 * User simulator agents are responsible for generating user messages to drive the conversation.
 */
export abstract class UserSimulatorAgentAdapter implements AgentAdapter {
  role: AgentRole = AgentRole.USER;

  constructor(input: AgentInput) {
    void input;
  }

  /**
   * Process the input and generate a user message.
   *
   * @param input AgentInput containing conversation history, thread context, and scenario state.
   * @returns The user's response.
   */
  abstract call(input: AgentInput): Promise<AgentReturnTypes>;
}

/**
 * Abstract base class for judge agents.
 * Judge agents are responsible for evaluating the conversation and determining success or failure.
 */
export abstract class JudgeAgentAdapter implements AgentAdapter {
  role: AgentRole = AgentRole.JUDGE;
  /**
   * The criteria the judge will use to evaluate the conversation.
   */
  abstract criteria: string[];

  constructor(input: AgentInput) {
    void input;
  }

  /**
   * Process the input and evaluate the conversation.
   *
   * @param input AgentInput containing conversation history, thread context, and scenario state.
   * @returns A ScenarioResult if the conversation should end, otherwise should continue.
   */
  abstract call(input: AgentInput): Promise<AgentReturnTypes>;
}
