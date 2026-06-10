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

import {
  voiceAgentStep,
  withUserStepOverride,
  type VoiceAgentOptions,
  type VoiceUserOptions,
} from "./voice-steps";

export {
  sleep,
  silence,
  audio,
  dtmf,
  interrupt,
  backgroundNoise,
  proceed as voiceProceed,
  type InterruptOptions,
  type VoiceAgentOptions,
  type VoiceProceedOptions,
  type VoiceUserOptions,
} from "./voice-steps";

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
 * This is the single agent step for both text and voice scenarios (PRD §9,
 * §6.2; EDR §0). It accepts either response content **or** a voice-options
 * object:
 *
 * - `agent()` — the agent under test generates its response (blocking).
 * - `agent("text")` / `agent(modelMessage)` — use the provided content.
 * - `agent({ wait: false, content? })` — fire the agent turn **without
 *   awaiting** it (the non-blocking voice primitive for interruption /
 *   barge-in testing). Control returns immediately so subsequent steps
 *   (`sleep`, `silence`, `user`) run while the agent keeps speaking. This is
 *   the flagship interruption flow: `agent({ wait: false })` → `sleep(n)` →
 *   `user("…")` → `agent()` → `judge()`.
 *
 * The two forms are disambiguated structurally: a `ModelMessage` carries a
 * `role` discriminant, whereas {@link VoiceAgentOptions} (`{ wait?, content? }`)
 * does not — so a plain options object is never mistaken for a message, and a
 * message is never mistaken for options.
 *
 * `scenario.voiceAgent` is exported as a thin alias of this step for callers
 * that prefer an explicit voice-named symbol; both resolve to the same
 * behavior.
 *
 * @param contentOrOptions Optional agent response content (string / message)
 *                         or a voice-options object (`{ wait, content }`).
 * @returns A ScriptStep function that can be used in scenario scripts.
 */
export function agent(content?: string | ModelMessage): ScriptStep;
export function agent(options: VoiceAgentOptions): ScriptStep;
export function agent(
  contentOrOptions?: string | ModelMessage | VoiceAgentOptions,
): ScriptStep {
  if (isVoiceAgentOptions(contentOrOptions)) {
    return voiceAgentStep(contentOrOptions);
  }
  return voiceAgentStep({ content: contentOrOptions });
}

/**
 * Voice-named alias of {@link agent}. Identical behavior — kept so existing
 * `scenario.voiceAgent({ wait: false })` call sites (demos, tests, docs)
 * continue to work unchanged. New code can use either name; the PRD idiom is
 * `scenario.agent({ wait: false })`.
 */
export const voiceAgent = (options: VoiceAgentOptions = {}): ScriptStep =>
  voiceAgentStep(options);

/**
 * Discriminate a voice-options object from agent response content.
 *
 * A {@link VoiceAgentOptions} is a plain object with NO `role` field; every
 * `ModelMessage` carries a required `role` discriminant (`"user"` /
 * `"assistant"` / `"system"` / `"tool"`). Strings, `undefined`, arrays, and
 * messages are therefore routed to the content branch; only a bare
 * `{ wait?, content? }` object is treated as options.
 */
function isVoiceAgentOptions(
  value: string | ModelMessage | VoiceAgentOptions | undefined,
): value is VoiceAgentOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !("role" in value)
  );
}

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
 * Voice (PRD §4.2): pass `{ voiceStyle }` and/or `{ audioEffects }` to apply
 * a per-step override to ONLY this turn's synthesized audio
 * (`scenario.user("I'm upset!", { voiceStyle: "angry" })`). The simulator's
 * default voice/effects resume on subsequent turns.
 *
 * @param content Optional user message content. Can be a string or full message object.
 *                If undefined, the user simulator will generate content automatically.
 * @param options Optional per-step voice overrides (`voiceStyle`, `audioEffects`).
 * @returns A ScriptStep function that can be used in scenario scripts.
 */
export const user = (
  content?: string | ModelMessage,
  options?: VoiceUserOptions,
): ScriptStep => {
  return (_state, executor) =>
    withUserStepOverride(executor, options, () => executor.user(content));
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
