/**
 * Message Transformer
 *
 * Handles conversion between Scenario framework message formats and
 * realtime message formats. Isolates message format concerns from
 * the rest of the system.
 */

import type { AgentInput, AgentReturnTypes } from "@langwatch/scenario";
import type { AssistantModelMessage } from "ai";
import type { RealtimeMessage, AudioResponse } from "./types.js";
import type { Logger } from "./logger.js";

export interface MessageTransformer {
  /**
   * Converts Scenario AgentInput to RealtimeMessage
   */
  toRealtimeFormat(input: AgentInput): RealtimeMessage;

  /**
   * Converts AudioResponse to Scenario AgentReturnTypes
   */
  fromRealtimeFormat(response: AudioResponse): AgentReturnTypes;
}

export interface MessageTransformerConfig {
  /** Logger for transformation events */
  logger?: Logger;
}

/**
 * Default implementation of MessageTransformer
 *
 * Handles conversion between Scenario's message formats and the
 * realtime API's expected formats.
 */
export class DefaultMessageTransformer implements MessageTransformer {
  constructor(private config: MessageTransformerConfig = {}) {}

  toRealtimeFormat(input: AgentInput): RealtimeMessage {
    // Get the latest user message
    const latestMessage = input.newMessages[input.newMessages.length - 1];

    if (!latestMessage) {
      throw new Error("No messages in input");
    }

    // Handle audio messages
    if (Array.isArray(latestMessage.content)) {
      for (const part of latestMessage.content) {
        if (part.type === "file" && part.mediaType?.startsWith("audio/")) {
          // Validate audio data
          if (typeof part.data !== "string") {
            throw new Error(
              `Audio data must be base64 string, got: ${typeof part.data}`
            );
          }

          if (!part.data || part.data.length === 0) {
            throw new Error("Audio message has no data");
          }

          this.config.logger?.info("Transforming audio message to realtime format", {
            mediaType: part.mediaType,
            dataLength: part.data.length,
          });

          return {
            type: "audio",
            content: part.data,
            metadata: {
              mediaType: part.mediaType,
            },
          };
        }
      }
    }

    // Handle text messages
    const text =
      typeof latestMessage.content === "string" ? latestMessage.content : "";

    if (!text) {
      throw new Error("Message has no text or audio content");
    }

    this.config.logger?.debug("Transforming text message to realtime format", {
      textLength: text.length,
    });

    return {
      type: "text",
      content: text,
    };
  }

  fromRealtimeFormat(response: AudioResponse): AgentReturnTypes {
    // For audio responses, return both text and audio
    if (response.audio && response.audio.length > 0) {
      this.config.logger?.info("Transforming audio response to Scenario format", {
        transcriptLength: response.transcript.length,
        audioLength: response.audio.length,
      });

      return {
        role: "assistant",
        content: [
          { type: "text", text: response.transcript },
          { type: "file", mediaType: "audio/pcm16", data: response.audio },
        ],
      } as AssistantModelMessage;
    }

    // For text-only responses
    this.config.logger?.debug("Transforming text response to Scenario format", {
      textLength: response.transcript.length,
    });

    return response.transcript;
  }
}
