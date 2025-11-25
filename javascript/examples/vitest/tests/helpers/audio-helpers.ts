/**
 * Audio Helpers - Utilities for working with audio in Scenario tests
 *
 * Provides helpers for converting between audio and text formats,
 * and wrapping agents to use audio APIs.
 */
import {
  InvokeLLMParams,
  InvokeLLMResult,
  JudgeAgent,
  UserSimulatorAgent,
} from "@langwatch/scenario";
import OpenAI from "openai";
import { convertModelMessagesToOpenAIMessages } from "./convert-core-messages-to-openai";

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
 * const audioUserSim = AudioHelpers.wrapAgentForOpenAiAudio(
 *   scenario.userSimulatorAgent(),
 *   { voice: "nova" }
 * );
 *
 * const audioJudge = AudioHelpers.wrapAgentForOpenAiAudio(
 *   scenario.judgeAgent({ criteria: [...] }),
 *   { voice: "alloy" }
 * );
 * ```
 */
export function wrapAgentForOpenAiAudio<
  T extends JudgeAgent | UserSimulatorAgent
>(agent: T, options: AudioWrapOptions = {}): T {
  agent.invokeLLM = async (
    params: InvokeLLMParams
  ): Promise<InvokeLLMResult> => {
    try {
      // Use OpenAI audio API instead of text API
      const response = await openai.chat.completions.create({
        model: options.model || "gpt-4o-audio-preview",
        modalities: ["text", "audio"],
        audio: { voice: options.voice || "alloy", format: "wav" },
        messages: convertModelMessagesToOpenAIMessages(params.messages),
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
        // Required field for InvokeLLMResult
        text: transcript,
        content: [
          {
            type: "text",
            text: "",
          },
          {
            type: "file" as const,
            data: response.choices[0].message?.audio?.data,
            mimeType: "audio/wav",
          },
        ],
        // Force cast. We're only using the audio here.
      } as unknown as InvokeLLMResult;
    } catch (error) {
      console.error("Audio API call failed:", error);
      throw error;
    }
  };

  return agent;
}

// Export the namespace
export const AudioHelpers = {
  wrapAgentForOpenAiAudio,
};
