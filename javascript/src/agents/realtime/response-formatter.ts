import type { AssistantModelMessage } from "ai";

import { encodeWav } from "../../voice/recording.runtime.js";
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
        // WAV-wrap the raw PCM16 the Realtime API delivers before persisting.
        // OpenAI Realtime streams headerless PCM16 on the wire; emitting it
        // verbatim as `audio/pcm16` produces a content part the LangWatch app
        // (and any browser `<audio>`) cannot decode -> the simulations UI shows
        // an `[error]` badge instead of a player. Python parity:
        // `python/scenario/voice/messages.py` emits `format: "wav"` with
        // base64 WAV. Mirror that here.
        {
          type: "file",
          mediaType: "audio/wav",
          data: pcm16Base64ToWavBase64(audioEvent.audio),
        },
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

/**
 * Wrap a base64-encoded raw PCM16 (24kHz, mono) payload in a canonical WAV
 * container and return it base64-encoded. Reuses {@link encodeWav} so the
 * RIFF header stays identical to the recording path (and to Python).
 */
function pcm16Base64ToWavBase64(pcmBase64: string): string {
  const pcm = Buffer.from(pcmBase64, "base64");
  const wav = encodeWav([new Uint8Array(pcm)], pcm.length);
  return Buffer.from(wav).toString("base64");
}
