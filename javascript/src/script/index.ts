/**
 * Scenario script DSL (Domain Specific Language) module.
 *
 * This module provides a collection of functions that form a declarative language
 * for controlling scenario execution flow. These functions can be used to create
 * scripts that precisely control how conversations unfold, when evaluations occur,
 * and when scenarios should succeed or fail.
 */
import { CoreMessage } from "ai";
import { ScenarioExecutionStateLike, ScriptStep } from "../domain";

/**
 * Add a specific message to the conversation.
 *
 * This function allows you to inject any CoreMessage compatible message directly
 * into the conversation at a specific point in the script. Useful for
 * simulating tool responses, system messages, or specific conversational states.
 *
 * @param message The message to add to the conversation.
 * @returns A ScriptStep function that can be used in scenario scripts.
 */
export const message = (message: CoreMessage): ScriptStep => {
  return (_state, executor) => executor.message(message);
};

/**
 * Generate or specify an agent response in the conversation.
 *
 * If content is provided, it will be used as the agent response. If no content
 * is provided, the agent under test will be called to generate its response
 * based on the current conversation state.
 *
 * @param content Optional agent response content. Can be a string or full message object.
 *                If undefined, the agent under test will generate content automatically.
 * @returns A ScriptStep function that can be used in scenario scripts.
 */
export const agent = (content?: string | CoreMessage): ScriptStep => {
  return (_state, executor) => executor.agent(content);
};

/**
 * Invoke the judge agent to evaluate the current conversation state.
 *
 * This function forces the judge agent to make a decision about whether
 * the scenario should continue or end with a success/failure verdict.
 * The judge will evaluate based on its configured criteria.
 *
 * @param content Optional message content for the judge. Usually undefined to let
 *                the judge evaluate based on its criteria.
 * @returns A ScriptStep function that can be used in scenario scripts.
 */
export const judge = (content?: string | CoreMessage): ScriptStep => {
  return (_state, executor) => executor.judge(content);
};

/**
 * Generate or specify a user message in the conversation.
 *
 * If content is provided, it will be used as the user message. If no content
 * is provided, the user simulator agent will automatically generate an
 * appropriate message based on the scenario context.
 *
 * @param content Optional user message content. Can be a string or full message object.
 *                If undefined, the user simulator will generate content automatically.
 * @returns A ScriptStep function that can be used in scenario scripts.
 */
export const user = (content?: string | CoreMessage): ScriptStep => {
  return (_state, executor) => executor.user(content);
};

/**
 * Let the scenario proceed automatically for a specified number of turns.
 *
 * This function allows the scenario to run automatically with the normal
 * agent interaction flow (user -> agent -> judge evaluation). You can
 * optionally provide callbacks to execute custom logic at each turn or step.
 *
 * @param turns Number of turns to proceed automatically. If undefined, proceeds until
 *              the judge agent decides to end the scenario or max_turns is reached.
 * @param onTurn Optional callback function called at the end of each turn.
 * @param onStep Optional callback function called after each agent interaction.
 * @returns A ScriptStep function that can be used in scenario scripts.
 */
export const proceed = (
  turns?: number,
  onTurn?: (state: ScenarioExecutionStateLike) => void | Promise<void>,
  onStep?: (state: ScenarioExecutionStateLike) => void | Promise<void>
): ScriptStep => {
  return (_state, executor) => executor.proceed(turns, onTurn, onStep);
};

/**
 * End the scenario with a success verdict.
 *
 * This function immediately concludes the scenario and marks it as successful.
 *
 * @param reasoning Optional explanation for why the scenario succeeded.
 * @returns A ScriptStep function that can be used in scenario scripts.
 */
export const succeed = (reasoning?: string): ScriptStep => {
  return (_state, executor) => executor.succeed(reasoning);
};

/**
 * End the scenario with a failure verdict.
 *
 * This function immediately concludes the scenario and marks it as failed.
 *
 * @param reasoning Optional explanation for why the scenario failed.
 * @returns A ScriptStep function that can be used in scenario scripts.
 */
export const fail = (reasoning?: string): ScriptStep => {
  return (_state, executor) => executor.fail(reasoning);
};
