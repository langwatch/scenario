/**
 * Audio transcription utilities for converting audio to text.
 *
 * Uses OpenAI Whisper API for transcription with caching to avoid
 * re-transcribing the same audio multiple times.
 */
import { CoreMessage } from "ai";
import OpenAI from "openai";

/**
 * Cache mapping base64 audio data to transcribed text.
 */
const transcriptionCache = new Map<string, string>();

/**
 * Transcribes audio data to text using OpenAI Whisper.
 *
 * @param audioData - Base64-encoded audio data.
 * @param mediaType - MIME type of the audio (e.g., "audio/wav").
 * @returns Transcribed text.
 */
export async function transcribeAudio(
  audioData: string,
  mediaType: string = "audio/wav"
): Promise<string> {
  const cached = transcriptionCache.get(audioData);
  if (cached) return cached;

  try {
    const openai = new OpenAI();
    const ext = mediaType.split("/")[1] || "wav";
    const response = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: new File([Buffer.from(audioData, "base64")], `audio.${ext}`, {
        type: mediaType,
      }),
    });
    transcriptionCache.set(audioData, response.text);
    return response.text;
  } catch (error) {
    console.error("Error transcribing audio:", error);
    return "[Audio: transcription failed]";
  }
}

/**
 * Converts audio parts in messages to text transcriptions.
 *
 * Scans all message content for audio file parts, transcribes them
 * using OpenAI Whisper, and returns messages with audio converted to text.
 *
 * @param messages - Original messages potentially containing audio.
 * @returns Messages with audio converted to text transcriptions.
 */
export async function transcribeAudioInMessages(
  messages: CoreMessage[]
): Promise<CoreMessage[]> {
  return await Promise.all(
    messages.map(async (message) => {
      if (message.role === "tool") {
        return message;
      }

      if (Array.isArray(message.content)) {
        const textParts = await Promise.all(
          message.content.map(async (part) => {
            if (part.type === "text") return part.text;
            if (part.type === "file" && part.mediaType?.startsWith("audio/")) {
              return await transcribeAudio(
                part.data as string,
                part.mediaType
              );
            }
            return "";
          })
        );

        const textContent = textParts.filter(Boolean).join(" ");
        return { ...message, content: textContent || "[Audio message]" };
      }
      return message;
    })
  );
}
