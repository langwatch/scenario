import { CoreMessage } from "ai";
import { ScenarioExecutionStateLike } from "../index";

/**
 * Represents a typed script command that describes a specific action to take
 * during scenario execution. Commands are data structures that can be serialized
 * and provide type safety for scenario scripts.
 */
export type ScriptCommand =
  | MessageCommand
  | UserCommand
  | AgentCommand
  | JudgeCommand
  | ProceedCommand
  | SucceedCommand
  | FailCommand;

/**
 * Command to add a specific message directly to the conversation.
 * Useful for simulating tool responses, system messages, or specific conversational states.
 */
export interface MessageCommand {
  readonly type: "message";
  readonly message: CoreMessage;
}

/**
 * Command to generate or specify a user message in the conversation.
 * If content is not provided, the user simulator agent will generate content automatically.
 */
export interface UserCommand {
  readonly type: "user";
  readonly content?: string | CoreMessage;
}

/**
 * Command to generate or specify an agent response in the conversation.
 * If content is not provided, the agent under test will generate content automatically.
 */
export interface AgentCommand {
  readonly type: "agent";
  readonly content?: string | CoreMessage;
}

/**
 * Command to invoke the judge agent to evaluate the current conversation state.
 * The judge will evaluate based on its configured criteria and may end the scenario.
 */
export interface JudgeCommand {
  readonly type: "judge";
  readonly content?: string | CoreMessage;
}

/**
 * Command to let the scenario proceed automatically for a specified number of turns.
 * Agents will interact naturally according to their roles until the turn limit is reached
 * or the judge decides to end the scenario.
 */
export interface ProceedCommand {
  readonly type: "proceed";
  readonly turns?: number;
  readonly onTurn?: (state: ScenarioExecutionStateLike) => void | Promise<void>;
  readonly onStep?: (state: ScenarioExecutionStateLike) => void | Promise<void>;
}

/**
 * Command to immediately end the scenario with a success verdict.
 */
export interface SucceedCommand {
  readonly type: "succeed";
  readonly reasoning?: string;
}

/**
 * Command to immediately end the scenario with a failure verdict.
 */
export interface FailCommand {
  readonly type: "fail";
  readonly reasoning?: string;
}
