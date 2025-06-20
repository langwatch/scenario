import { CoreMessage } from "ai";
import { AgentAdapter } from "../agents/index";
import { ScenarioExecutionStateLike, ScenarioResult } from "../core/execution";

/**
 * Configuration for a scenario.
 */
export interface ScenarioConfig {
  /**
   * Optional unique identifier for the scenario.
   * If not provided, a UUID will be generated.
   */
  id?: string;
  /**
   * The name of the scenario.
   */
  name: string;
  /**
   * A description of what the scenario tests.
   */
  description: string;

  /**
   * The agents participating in the scenario.
   */
  agents: AgentAdapter[];
  /**
   * The script of steps to execute for the scenario.
   */
  script?: ScriptStep[];

  /**
   * Whether to output verbose logging. Defaults to false.
   */
  verbose?: boolean;
  /**
   * The maximum number of turns to execute. Defaults to 20.
   */
  maxTurns?: number;

  /**
   * Optional thread ID to use for the conversation.
   * If not provided, a new thread will be created.
   */
  threadId?: string;
}

/**
 * Final, normalized scenario configuration.
 * All optional fields are filled with default values.
 * @internal
 */
export interface ScenarioConfigFinal extends Omit<ScenarioConfig, "id" | "script" | "threadId" | "verbose" | "maxTurns"> {
  id: string;
  script: ScriptStep[];

  verbose: boolean;
  maxTurns: number;
  threadId: string;
}

/**
 * The execution context for a scenario script.
 * This provides the functions to control the flow of the scenario.
 */
export interface ScenarioExecutionLike {
  /**
   * The history of messages in the conversation.
   */
  readonly history: CoreMessage[];
  /**
   * The ID of the conversation thread.
   */
  readonly threadId: string;

  /**
   * Adds a message to the conversation.
   * @param message The message to add.
   */
  message(message: CoreMessage): Promise<void>;
  /**
   * Adds a user message to the conversation.
   * If no content is provided, the user simulator will generate a message.
   * @param content The content of the user message.
   */
  user(content?: string | CoreMessage): Promise<void>;
  /**
   * Adds an agent message to the conversation.
   * If no content is provided, the agent under test will generate a message.
   * @param content The content of the agent message.
   */
  agent(content?: string | CoreMessage): Promise<void>;
  /**
   * Invokes the judge agent to evaluate the current state.
   * @param content Optional message to the judge.
   * @returns The result of the scenario if the judge makes a final decision.
   */
  judge(content?: string | CoreMessage): Promise<ScenarioResult | null>;
  /**
   * Proceeds with the scenario automatically for a number of turns.
   * @param turns The number of turns to proceed. Defaults to running until the scenario ends.
   * @param onTurn Optional callback executed at the end of each turn.
   * @param onStep Optional callback executed after each agent interaction.
   * @returns The result of the scenario if it ends.
   */
  proceed(
    turns?: number,
    onTurn?: (state: ScenarioExecutionStateLike) => void | Promise<void>,
    onStep?: (state: ScenarioExecutionStateLike) => void | Promise<void>,
  ): Promise<ScenarioResult | null>;
  /**
   * Ends the scenario with a success.
   * @param reasoning Optional reasoning for the success.
   * @returns The final result of the scenario.
   */
  succeed(reasoning?: string): Promise<ScenarioResult>;
  /**
   * Ends the scenario with a failure.
   * @param reasoning Optional reasoning for the failure.
   * @returns The final result of the scenario.
   */
  fail(reasoning?: string): Promise<ScenarioResult>;
}

/**
 * A step in a scenario script.
 * This is a function that takes the current state and an executor, and performs an action.
 */
export type ScriptStep = (
  state: ScenarioExecutionStateLike,
  executor: ScenarioExecutionLike,
) => Promise<void | ScenarioResult | null> | void | ScenarioResult | null;
