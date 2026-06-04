/**
 * OpenAI Voice Agent - Base class for voice-to-voice AI agents
 *
 * This module provides a base class for creating agents that can:
 * - Accept audio input (voice messages from users)
 * - Generate audio output (voice responses)
 * - Handle multi-turn voice conversations
 *
 * Uses OpenAI's gpt-audio-mini model which supports voice-to-voice interaction.
 *
 * Example usage:
 * ```typescript
 * class MyVoiceAgent extends OpenAiVoiceAgent {
 *   role = AgentRole.AGENT;
 *   constructor() {
 *     super({
 *       systemPrompt: "You are a helpful assistant",
 *       voice: "alloy"
 *     });
 *   }
 * }
 * ```
 */
import { AgentAdapter, AgentInput, AgentRole } from "@langwatch/scenario";
import { ModelMessage, UserModelMessage, AssistantModelMessage } from "ai";
import OpenAI from "openai";
import {
  ChatCompletion,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.mjs";
import { convertModelMessagesToOpenAIMessages } from "./convert-core-messages-to-openai";

/**
 * Configuration options for voice-enabled agents
 */
interface VoiceAgentConfig {
  /** System prompt to guide the agent's behavior */
  systemPrompt?: string;
  /** OpenAI voice to use for audio generation */
  voice?: "alloy" | "nova" | "echo" | "fable" | "onyx" | "shimmer";
  /**
   * Force the agent's response to use "user" role instead of "assistant"
   *
   * Some judge agents may reject audio parts from the assistant role.
   * This is a workaround for that edge case with the OpenAI API.
   */
  forceUserRole?: boolean;
}

/**
 * Abstract base class for voice-enabled agents using OpenAI's voice-to-voice model
 *
 * This class handles:
 * - Converting messages to OpenAI format
 * - Calling the OpenAI audio API
 * - Processing audio responses
 * - Creating properly formatted audio messages
 *
 * Subclasses must define the `role` property (AGENT or USER)
 */
export abstract class OpenAiVoiceAgent extends AgentAdapter {
  private readonly openai = new OpenAI();
  private readonly config: VoiceAgentConfig;

  constructor(config?: VoiceAgentConfig) {
    super();
    this.config = config ?? { voice: "alloy" };
  }

  /**
   * Main entry point - processes input and generates audio response
   * @param input - Agent input containing conversation messages
   * @returns Audio message or text fallback
   */
  public async call(input: AgentInput): Promise<ModelMessage | string> {
    try {
      // Convert messages to OpenAI format for voice-to-voice model
      const messages = convertModelMessagesToOpenAIMessages(input.messages);
      const response = await this.respondWithAudio(messages);
      return this.handleResponse(response);
    } catch (error) {
      console.error(
        `${this.constructor.name} failed to generate a response`,
        error,
        input.messages
      );
      throw error;
    }
  }

  /**
   * Processes OpenAI API response and extracts audio or text
   *
   * Priority order:
   * 1. Audio data - creates audio message with base64 WAV data
   * 2. Text transcript - returns as plain text fallback
   * 3. Neither - throws error
   *
   * @param response - The raw ChatCompletion response from OpenAI
   * @returns Audio message or text string
   */
  private handleResponse(response: ChatCompletion) {
    // Extract audio data and transcript
    const audioData = response.choices[0].message?.audio?.data;
    const transcript = response.choices[0].message?.audio?.transcript;

    if (audioData) {
      console.log(
        `
${this.constructor.name} AUDIO RESPONSE
       `,
        transcript
      );
      return this.createAudioMessage(audioData);
    } else if (transcript) {
      console.log(
        `
${this.constructor.name} TEXT FALLBACK
       `,
        transcript
      );
      return transcript;
    } else {
      throw new Error(`${this.constructor.name} failed to generate a response`);
    }
  }

  /**
   * Calls OpenAI's audio-enabled model to generate voice response
   *
   * Uses gpt-audio-mini with:
   * - Text and audio modalities
   * - WAV format output
   * - Configured voice (alloy, nova, echo, etc.)
   * - Optional system prompt
   */
  private async respondWithAudio(
    messages: ChatCompletionMessageParam[]
  ): Promise<ChatCompletion> {
    return this.openai.chat.completions.create({
      model: "gpt-audio-mini",
      modalities: ["text", "audio"],
      audio: { voice: this.config.voice, format: "wav" },
      messages: this.systemMessage
        ? [this.systemMessage, ...messages]
        : messages,
      store: false,
    });
  }

  /**
   * Builds system message from config if present
   */
  private get systemMessage(): ChatCompletionMessageParam | undefined {
    if (!this.config.systemPrompt) return undefined;

    return {
      role: "system",
      content: this.config.systemPrompt,
    };
  }

  /**
   * Creates a properly formatted audio message for the conversation
   *
   * The message includes:
   * - Empty text part (required structure)
   * - File part with base64 WAV data
   * - Correct role (user or assistant) based on agent configuration
   *
   * @param audioData - Base64-encoded WAV audio data
   * @returns Formatted ModelMessage ready for conversation
   */
  private createAudioMessage(audioData: string): ModelMessage {
    this.validateRole(this.role);

    const content: ModelMessage["content"] = [
      {
        type: "text" as const,
        text: "",
      },
      {
        type: "file" as const,
        mediaType: "audio/wav" as const,
        data: audioData,
      },
    ];

    return this.role === AgentRole.USER || this.config.forceUserRole
      ? ({ role: "user", content } as UserModelMessage)
      : ({ role: "assistant", content } as AssistantModelMessage);
  }

  /**
   * Ensures the agent role is valid for voice operations
   * Only AGENT and USER roles are supported (not the raw "user"/"assistant" strings)
   */
  private validateRole(role: AgentRole) {
    if (["user", "assistant"].includes(role)) {
      throw new Error(
        `Role must be ${AgentRole.AGENT} or ${AgentRole.USER}. Received ${role}`
      );
    }
  }
}
