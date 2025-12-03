/**
 * Scenario script DSL (Domain Specific Language) module.
 *
 * This module provides a collection of functions that form a declarative language
 * for controlling scenario execution flow. These functions can be used to create
 * scripts that precisely control how conversations unfold, when evaluations occur,
 * and when scenarios should succeed or fail.
 */
import { ModelMessage, CoreMessage } from "ai";
import { textToSpeech } from "../audio/text-to-speech";
import type { Voice } from "../audio/types";
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
 * Script step type with optional speak method for TTS.
 */
interface SpeakableAgentStep extends ScriptStep {
  /**
   * Convert text to speech and send as audio message.
   *
   * @param options - TTS options including voice.
   * @returns A ScriptStep that sends audio.
   */
  speak: (options?: { voice?: Voice }) => ScriptStep;
}

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
 *
 * @example
 * ```typescript
 * // Text message
 * scenario.agent("Here's a recipe for you")
 *
 * // Audio message via TTS
 * scenario.agent.speak("Here's a recipe for you")
 *
 * // Let agent generate
 * scenario.agent()
 * ```
 */
const agentBase = (
  content?: string | CoreMessage
): ScriptStep | SpeakableAgentStep => {
  const step: ScriptStep = (_state, executor) => executor.agent(content);

  // Only add .speak() when text content is provided
  if (typeof content === "string") {
    const speakableStep = step as SpeakableAgentStep;
    speakableStep.speak = (options?: { voice?: Voice }): ScriptStep => {
      return async (_state, executor) => {
        const audio = await textToSpeech(content, { voice: options?.voice });
        const audioMessage: CoreMessage = {
          role: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "file", mediaType: audio.mediaType, data: audio.data },
          ],
        };
        await executor.message(audioMessage);
      };
    };
    return speakableStep;
  }

  return step;
};

/**
 * Speak text as an agent audio message via TTS.
 *
 * @param text - Text to convert to speech.
 * @param options - TTS options including voice.
 * @returns A ScriptStep that sends audio.
 *
 * @example
 * ```typescript
 * scenario.agent.speak("Here's a recipe for you")
 * ```
 */
const agentSpeak = (text: string, options?: { voice?: Voice }): ScriptStep => {
  return async (_state, executor) => {
    const audio = await textToSpeech(text, { voice: options?.voice });
    const audioMessage: CoreMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "file", mediaType: audio.mediaType, data: audio.data },
      ],
    };
    await executor.message(audioMessage);
  };
};

/**
 * Generate or specify an agent response in the conversation.
 *
 * Supports both text and audio output:
 * - `scenario.agent("text")` - Send text message
 * - `scenario.agent.speak("text")` - Send audio message via TTS
 * - `scenario.agent()` - Let agent generate
 */
export const agent = Object.assign(agentBase, { speak: agentSpeak });

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
 * @param options Optional options object with inline criteria to evaluate.
 * @returns A ScriptStep function that can be used in scenario scripts.
 */
export const judge = (options?: { criteria: string[] }): ScriptStep => {
  return async (_state, executor) => {
    await executor.judge(options);
  };
};

/**
 * Script step type with optional speak method for TTS.
 */
interface SpeakableUserStep extends ScriptStep {
  /**
   * Convert text to speech and send as audio message.
   *
   * @param options - TTS options including voice.
   * @returns A ScriptStep that sends audio.
   */
  speak: (options?: { voice?: Voice }) => ScriptStep;
}

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
 *
 * @example
 * ```typescript
 * // Text message
 * scenario.user("Hello")
 *
 * // Audio message via TTS
 * scenario.user.speak("Hello")
 *
 * // Let user simulator generate
 * scenario.user()
 * ```
 */
const userBase = (
  content?: string | CoreMessage
): ScriptStep | SpeakableUserStep => {
  const step: ScriptStep = (_state, executor) => executor.user(content);

  // Only add .speak() when text content is provided
  if (typeof content === "string") {
    const speakableStep = step as SpeakableUserStep;
    speakableStep.speak = (options?: { voice?: Voice }): ScriptStep => {
      return async (_state, executor) => {
        const audio = await textToSpeech(content, { voice: options?.voice });
        const audioMessage: CoreMessage = {
          role: "user",
          content: [
            { type: "text", text: "" },
            { type: "file", mediaType: audio.mediaType, data: audio.data },
          ],
        };
        await executor.message(audioMessage);
      };
    };
    return speakableStep;
  }

  return step;
};

/**
 * Speak text as a user audio message via TTS.
 *
 * @param text - Text to convert to speech.
 * @param options - TTS options including voice.
 * @returns A ScriptStep that sends audio.
 *
 * @example
 * ```typescript
 * scenario.user.speak("I need help with billing")
 * ```
 */
const userSpeak = (text: string, options?: { voice?: Voice }): ScriptStep => {
  return async (_state, executor) => {
    const audio = await textToSpeech(text, { voice: options?.voice });
    const audioMessage: CoreMessage = {
      role: "user",
      content: [
        { type: "text", text: "" },
        { type: "file", mediaType: audio.mediaType, data: audio.data },
      ],
    };
    await executor.message(audioMessage);
  };
};

/**
 * Generate or specify a user message in the conversation.
 *
 * Supports both text and audio output:
 * - `scenario.user("text")` - Send text message
 * - `scenario.user.speak("text")` - Send audio message via TTS
 * - `scenario.user()` - Let user simulator generate
 */
export const user = Object.assign(userBase, { speak: userSpeak });

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
