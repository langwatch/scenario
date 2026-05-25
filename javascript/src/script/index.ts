/**
 * Scenario script DSL (Domain Specific Language) module.
 *
 * This module provides a collection of functions that form a declarative language
 * for controlling scenario execution flow. These functions can be used to create
 * scripts that precisely control how conversations unfold, when evaluations occur,
 * and when scenarios should succeed or fail.
 */
import { ModelMessage } from "ai";
import { ScenarioExecutionStateLike, ScriptStep } from "../domain";

/**
 * Add a specific message to the conversation.
 *
 * This function allows you to inject any ModelMessage compatible message directly
 * into the conversation at a specific point in the script. Useful for
 * simulating tool responses, system messages, or specific conversational states.
 *
 * @param message The message to add to the conversation.
 * @returns A ScriptStep function that can be used in scenario scripts.
 */
export const message = (message: ModelMessage): ScriptStep => {
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
export const agent = (content?: string | ModelMessage): ScriptStep => {
  return (_state, executor) => executor.agent(content);
};

/**
 * Invoke the judge agent to evaluate the current conversation state.
 *
 * When criteria are provided inline, the judge evaluates only those criteria
 * as a checkpoint: if all pass, the scenario continues; if any fail, the
 * scenario fails immediately. This is the preferred way to pass criteria
 * when using scripts.
 *
 * When no criteria are provided, the judge uses its own configured criteria
 * and returns a final verdict (success or failure), ending the scenario.
 *
 * @param options Optional options object with inline criteria and/or context to evaluate.
 *   - `criteria`: Criteria to evaluate (overrides judge's configured criteria).
 *   - `context`: Additional context for the judge, e.g. filesystem state or command output.
 *     Included in the judge's prompt under `<additional_context>`.
 * @returns A ScriptStep function that can be used in scenario scripts.
 */
export const judge = (options?: { criteria?: string[]; context?: string }): ScriptStep => {
  return async (_state, executor) => {
    await executor.judge(options);
  };
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
export const user = (content?: string | ModelMessage): ScriptStep => {
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
  return async (_state, executor) => {
    await executor.proceed(turns, onTurn, onStep);
  };
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
  return async (_state, executor) => {
    await executor.succeed(reasoning);
  };
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
  return async (_state, executor) => {
    await executor.fail(reasoning);
  };
};
