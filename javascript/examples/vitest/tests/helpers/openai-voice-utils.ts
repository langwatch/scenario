/**
 * OpenAI Voice utilities namespace
 *
 * Provides helpers for calling OpenAI's audio API and formatting voice responses.
 */
import OpenAI from "openai";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import { AgentRole } from "@langwatch/scenario";
import { UserModelMessage, AssistantModelMessage, ModelMessage } from "ai";

/**
 * Options for calling OpenAI voice API
 */
export interface VoiceCallOptions {
  /** Voice to use for audio generation */
  voice?: "alloy" | "nova" | "echo" | "fable" | "onyx" | "shimmer";
  /** Model to use (defaults to gpt-4o-audio-preview) */
  model?: string;
  /** Optional tools for function calling */
  tools?: any[];
}

/**
 * Response from OpenAI voice API call
 */
export interface VoiceResponse {
  /** Base64-encoded WAV audio data */
  audioData?: string;
  /** Text transcript of the audio */
  transcript?: string;
  /** Raw OpenAI completion response */
  rawResponse: any;
}

/**
 * Options for creating audio messages
 */
export interface AudioMessageOptions {
  /** Agent role (must be AgentRole enum, not raw string) */
  role: AgentRole | "user" | "assistant";
  /** Force using "user" role instead of "assistant" */
  forceUserRole?: boolean;
}

/**
 * OpenAI voice utilities
 *
 * Namespaced utilities for voice-to-voice interactions with OpenAI's audio API.
 */
export const OpenAIVoice = {
  /**
   * Call OpenAI audio API with proper message handling
   *
   * @param openai - OpenAI client instance
   * @param messages - Already converted OpenAI format messages
   * @param options - Voice configuration options
   * @returns Audio response with data and transcript
   */
  async call(
    openai: OpenAI,
    messages: ChatCompletionMessageParam[],
    options: VoiceCallOptions = {}
  ): Promise<VoiceResponse> {
    const { voice = "alloy", model = "gpt-4o-audio-preview", tools } = options;

    // OpenAI audio API requires at least one user message
    if (messages.length === 1 && messages[0].role === "system") {
      messages.push({ role: "user", content: "" });
    }

    const response = await openai.chat.completions.create({
      model,
      modalities: ["text", "audio"],
      audio: { voice, format: "wav" },
      messages,
      tools,
      store: false,
    });

    return {
      audioData: response.choices[0].message?.audio?.data,
      transcript: response.choices[0].message?.audio?.transcript,
      rawResponse: response,
    };
  },

  /**
   * Create properly formatted audio content for CoreMessage
   *
   * @param audioData - Base64 WAV audio data
   * @returns Multipart content with empty text and audio file
   */
  createContent(audioData: string) {
    return [
      { type: "text" as const, text: "" }, // Empty text per OpenAI voice spec
      {
        type: "file" as const,
        mediaType: "audio/wav" as const,
        data: audioData,
      },
    ];
  },

  /**
   * Create a properly formatted audio message with role validation
   *
   * The message includes:
   * - Empty text part (required structure)
   * - File part with base64 WAV data
   * - Correct role (user or assistant) based on agent configuration
   *
   * @param audioData - Base64-encoded WAV audio data
   * @param options - Role and configuration options
   * @returns Formatted ModelMessage ready for conversation
   * @throws Error if role is invalid (must be AgentRole enum, not raw string)
   */
  createMessage(audioData: string, options: AudioMessageOptions): ModelMessage {
    this.validateRole(options.role);

    const content: ModelMessage["content"] = this.createContent(audioData);

    return options.role === AgentRole.USER || options.forceUserRole
      ? ({ role: "user", content } as UserModelMessage)
      : ({ role: "assistant", content } as AssistantModelMessage);
  },

  /**
   * Processes OpenAI voice API response and returns appropriate format
   *
   * Priority order:
   * 1. Audio data - returns audio message with proper role
   * 2. Text transcript - returns plain text fallback
   * 3. Neither - throws error
   *
   * @param response - Voice response from OpenAIVoice.call()
   * @param options - Role and configuration options
   * @param agentName - Optional agent name for logging
   * @returns Audio message with role or text string
   * @throws Error if response contains neither audio nor transcript
   *
   * @example
   * ```typescript
   * const response = await OpenAIVoice.call(openai, messages, { voice: "nova" });
   * return OpenAIVoice.handleResponse(response, { role: AgentRole.AGENT }, "MyAgent");
   * ```
   */
  handleResponse(
    response: VoiceResponse,
    options: AudioMessageOptions,
    agentName?: string
  ): ModelMessage | string {
    const name = agentName || "OpenAIVoice";

    if (response.audioData) {
      console.log(`\n${name} AUDIO RESPONSE\n`, response.transcript);
      return this.createMessage(response.audioData, options);
    } else if (response.transcript) {
      console.log(`\n${name} TEXT FALLBACK\n`, response.transcript);
      return response.transcript;
    } else {
      throw new Error(
        `${name}: OpenAI voice response contained neither audio data nor transcript`
      );
    }
  },

  /**
   * Strip response audio format from assistant message for sending back to OpenAI
   *
   * OpenAI returns audio in response format (`audio: { data, transcript }`), but this
   * format cannot be sent back in the messages array. Assistant messages with audio
   * should be converted to text (using the transcript) when included in subsequent requests.
   *
   * Note: User messages with audio should use `input_audio` format instead
   * (see convertModelMessagesToOpenAIMessages).
   *
   * @param message - OpenAI assistant message that may contain response audio format
   * @returns Clean message with transcript as content, safe to send back to OpenAI
   */
  stripAudioFromMessage(message: any): ChatCompletionMessageParam {
    const { audio, ...cleanMessage } = message;

    // If there was audio, use the transcript as content
    if (audio?.transcript) {
      return {
        ...cleanMessage,
        content: audio.transcript,
      } as ChatCompletionMessageParam;
    }

    return cleanMessage as ChatCompletionMessageParam;
  },

  /**
   * Validates that the agent role is valid for voice operations
   *
   * Only AGENT and USER AgentRole enum values are supported.
   * Raw "user"/"assistant" strings are not allowed to prevent confusion.
   *
   * @param role - Agent role to validate
   * @throws Error if role is a raw string instead of AgentRole enum
   */
  validateRole(role: AgentRole | "user" | "assistant"): void {
    if (["user", "assistant"].includes(role as string)) {
      throw new Error(
        `Role must be ${AgentRole.AGENT} or ${AgentRole.USER} (AgentRole enum). Received raw string: ${role}`
      );
    }
  },
};
