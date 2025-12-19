import type { AssistantModelMessage } from "ai";
import type { AudioResponseEvent } from "./realtime-event-handler.js";

/**
 * Formats responses for the Scenario framework
 *
 * This class handles the conversion of Realtime API responses into the
 * expected format for the Scenario testing framework.
 */
export class ResponseFormatter {
  /**
   * Formats an audio response event into Scenario framework format
   *
   * @param audioEvent - The audio response event from the Realtime API
   * @returns Formatted assistant message with audio and text content
   */
  formatAudioResponse(audioEvent: AudioResponseEvent): AssistantModelMessage {
    return {
      role: "assistant",
      content: [
        { type: "text", text: audioEvent.transcript },
        { type: "file", mediaType: "audio/pcm16", data: audioEvent.audio },
      ],
    } as AssistantModelMessage;
  }

  /**
   * Formats a text response for the Scenario framework
   *
   * @param text - The text response from the agent
   * @returns Plain text response string
   */
  formatTextResponse(text: string): string {
    return text;
  }

  /**
   * Creates an initial response message for when no user message exists
   *
   * @param audioEvent - The audio response event from the Realtime API
   * @returns Formatted assistant message for initial responses
   */
  formatInitialResponse(audioEvent: AudioResponseEvent): AssistantModelMessage {
    return this.formatAudioResponse(audioEvent);
  }
}
