/**
 * Audio Helpers - Utilities for working with audio in Scenario tests
 *
 * Provides helpers for converting between audio and text formats,
 * and wrapping agents to use audio APIs.
 */
import {
  AgentAdapter,
  InvokeLLMParams,
  InvokeLLMResult,
} from "@langwatch/scenario";
import OpenAI from "openai";

const openai = new OpenAI();

/**
 * Options for audio wrapping
 */
export interface AudioWrapOptions {
  /** OpenAI voice to use for audio generation */
  voice?: "alloy" | "nova" | "echo" | "fable" | "onyx" | "shimmer";
  /** OpenAI model to use */
  model?: string;
}

/**
 * Wraps a Scenario agent to use OpenAI's audio API instead of text API
 *
 * This is specifically for Scenario's built-in agents (UserSimulatorAgent, JudgeAgent)
 * that have an invokeLLM method. The wrapper overrides invokeLLM to use audio APIs.
 *
 * @param agent - The agent to wrap (must have invokeLLM method)
 * @param options - Audio configuration options
 * @returns The same agent with audio-enabled invokeLLM
 *
 * @example
 * ```typescript
 * import { scenario, AudioHelpers } from "@langwatch/scenario";
 *
 * const audioUserSim = AudioHelpers.wrapAgentForAudio(
 *   scenario.userSimulatorAgent(),
 *   { voice: "nova" }
 * );
 *
 * const audioJudge = AudioHelpers.wrapAgentForAudio(
 *   scenario.judgeAgent({ criteria: [...] }),
 *   { voice: "alloy" }
 * );
 * ```
 */
export function wrapAgentForAudio<T extends AgentAdapter>(
  agent: T,
  options: AudioWrapOptions = {}
): T {
  const originalInvokeLLM = (agent as any).invokeLLM.bind(agent);
  (agent as any).invokeLLM = async (
    params: InvokeLLMParams
  ): Promise<InvokeLLMResult> => {
    try {
      // Use OpenAI audio API instead of text API
      const response = await openai.chat.completions.create({
        model: options.model || "gpt-4o-audio-preview",
        modalities: ["text", "audio"],
        audio: { voice: options.voice || "alloy", format: "wav" },
        messages: params.messages,
        temperature: params.temperature,
        max_tokens: params.maxOutputTokens,
        // Note: Tools are not supported with audio API yet
      });

      // Return the transcript from the audio response
      const transcript = response.choices[0].message?.audio?.transcript;
      if (!transcript) {
        throw new Error("No transcript received from audio API");
      }

      return {
        text: transcript,
        toolCalls: [], // Audio API doesn't support tools yet
      };
    } catch (error) {
      console.error("Audio API call failed:", error);
      throw error;
    }
  };

  return agent;
}

// Export the namespace
export const AudioHelpers = {
  wrapAgentForAudio,
};
