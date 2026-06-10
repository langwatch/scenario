import type { AssistantModelMessage } from "ai";
import type { AudioResponseEvent } from "./realtime-event-handler.js";

/** A content part of an assistant message (text or audio file). */
type AssistantContentPart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; data: string };

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
   * The audio `file` part is always present. The transcript `text` part is
   * included ONLY when the transcript is a non-empty string — a degraded /
   * empty / undefined transcript (AC-JS7) omits the text part rather than
   * emitting `text: undefined` (a malformed part the AI SDK would coerce to
   * the literal `"undefined"` downstream). Callers that read text parts (the
   * user simulator's `stripAudioContent`, the role-reversal echo reframe) then
   * see no spurious text to surface or parrot.
   *
   * @param audioEvent - The audio response event from the Realtime API
   * @returns Formatted assistant message with audio and (when present) text content
   */
  formatAudioResponse(audioEvent: AudioResponseEvent): AssistantModelMessage {
    const content: AssistantContentPart[] = [];

    // Surface the transcript only when it is a real, non-empty string. Empty /
    // undefined transcripts (degraded ASR, silence) contribute no text part —
    // never `text: undefined` / the literal `"undefined"`. (AC-JS5 / AC-JS7)
    const transcript = audioEvent.transcript;
    if (typeof transcript === "string" && transcript.length > 0) {
      content.push({ type: "text", text: transcript });
    }

    content.push({
      type: "file",
      mediaType: "audio/pcm16",
      data: audioEvent.audio,
    });

    return {
      role: "assistant",
      content,
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
