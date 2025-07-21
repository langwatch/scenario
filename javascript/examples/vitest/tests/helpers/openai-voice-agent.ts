import { AgentAdapter, AgentInput, AgentRole } from "@langwatch/scenario";
import { CoreAssistantMessage, CoreMessage, CoreUserMessage } from "ai";
import OpenAI from "openai";
import {
  ChatCompletion,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.mjs";
import { convertCoreMessagesToOpenAIMessages } from "./convert-core-messages-to-openai";

/**
 * Configuration for voice-enabled agents
 */
interface VoiceAgentConfig {
  systemPrompt?: string;
  voice?: "alloy" | "nova" | "echo" | "fable" | "onyx" | "shimmer";
  /**
   * Sometimes, the judge agent will refuse to acknowledge audio parts
   * from the assistant, so we can force the role to be user when responding.
   *
   * This is a weird edge case, but is sometimes required with OpenAI API.
   */
  forceUserRole?: boolean;
}

/**
 * Abstract base class for voice-enabled agents using OpenAI's voice-to-voice model
 * Handles common audio generation and response processing logic
 */
export abstract class OpenAiVoiceAgent extends AgentAdapter {
  private readonly openai = new OpenAI();
  private readonly config: VoiceAgentConfig;

  constructor(config?: VoiceAgentConfig) {
    super();
    this.config = config ?? { voice: "alloy" };
  }

  public async call(input: AgentInput): Promise<CoreMessage | string> {
    try {
      // Convert messages to OpenAI format for voice-to-voice model
      const messages = convertCoreMessagesToOpenAIMessages(input.messages);
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
   * Handles the response from the OpenAI API.
   * If the response contains audio data, it creates an audio message.
   * Else/if the response contains a transcript, it returns the transcript.
   * If the response does not contain audio data or a transcript, it throws an error.
   * @param response - The response from the OpenAI API.
   * @returns The response from the OpenAI API.
   */
  private handleResponse(response: ChatCompletion) {
    // Extract audio data and transcript
    const audioData = response.choices[0].message?.audio?.data;
    const transcript = response.choices[0].message?.audio?.transcript;

    if (audioData) {
      console.log(`${this.constructor.name} AUDIO RESPONSE`, transcript);
      return this.createAudioMessage(audioData);
    } else if (transcript) {
      console.log(`${this.constructor.name} TEXT FALLBACK`, transcript);
      return transcript;
    } else {
      throw new Error(`${this.constructor.name} failed to generate a response`);
    }
  }

  /**
   * Responds with audio using OpenAI's voice-to-voice model
   */
  private async respondWithAudio(
    messages: ChatCompletionMessageParam[]
  ): Promise<ChatCompletion> {
    return this.openai.chat.completions.create({
      model: "gpt-4o-audio-preview",
      modalities: ["text", "audio"],
      audio: { voice: this.config.voice, format: "wav" },
      messages: this.systemMessage
        ? [this.systemMessage, ...messages]
        : messages,
      store: false,
    });
  }

  private get systemMessage(): ChatCompletionMessageParam | undefined {
    if (!this.config.systemPrompt) return undefined;

    return {
      role: "system",
      content: this.config.systemPrompt,
    };
  }

  /**
   * Creates an audio message with the appropriate role based on the agent's role
   */
  private createAudioMessage(audioData: string): CoreMessage {
    this.validateRole(this.role);

    const content = [
      {
        type: "text" as const,
        text: "",
      },
      {
        type: "file" as const,
        mimeType: "audio/wav" as const,
        data: audioData,
      },
    ];

    return this.role === AgentRole.USER || this.config.forceUserRole
      ? ({ role: "user", content } as CoreUserMessage)
      : ({ role: "assistant", content } as CoreAssistantMessage);
  }

  private validateRole(role: AgentRole) {
    if (["user", "assistant"].includes(role)) {
      throw new Error(
        `Role must be ${AgentRole.AGENT} or ${AgentRole.USER}. Received ${role}`
      );
    }
  }
}
