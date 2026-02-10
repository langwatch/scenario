/**
 * Message Sanitization for AI SDK v5
 *
 * AI SDK v5 doesn't support audio file parts in message content,
 * so this utility converts audio data to text transcriptions using Whisper.
 *
 * Use this when passing audio conversations to judge agents or other
 * components that expect text-only content.
 *
 * Features:
 * - Automatic audio transcription via OpenAI Whisper
 * - Caching to avoid re-transcribing the same audio
 * - Graceful fallback for transcription errors
 */
import { ModelMessage } from "ai";
import OpenAI from "openai";

/**
 * Cache mapping base64 audio data to transcribed text
 * Avoids re-transcribing the same audio multiple times
 */
const cache = new Map<string, string>();

/**
 * Converts audio parts in messages to text transcriptions
 *
 * Process:
 * 1. Scans all message content for audio file parts
 * 2. Transcribes audio using OpenAI Whisper (with caching)
 * 3. Replaces audio parts with transcribed text
 * 4. Returns sanitized messages compatible with AI SDK v5
 *
 * @param messages - Original messages potentially containing audio
 * @returns Messages with audio converted to text transcriptions
 */
export async function sanitizeMessagesForV5(
  messages: ModelMessage[]
): Promise<ModelMessage[]> {
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
              const cached = cache.get(part.data as string);
              if (cached) return cached;
              const transcription = await transcribeAudio(part.data as string);
              cache.set(part.data as string, transcription);
              return transcription;
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

/**
 * Transcribes audio data to text using OpenAI Whisper
 *
 * @param audioData - Base64-encoded audio data
 * @returns Transcribed text, or error placeholder if transcription fails
 */
async function transcribeAudio(audioData: string): Promise<string> {
  try {
    const openaiClient = new OpenAI();
    // Convert base64 audio to File object for Whisper API
    const response = await openaiClient.audio.transcriptions.create({
      model: "whisper-1",
      file: new File([Buffer.from(audioData, "base64")], "audio.wav", {
        type: "audio/wav",
      }),
      language: "en",
    });
    return response.text;
  } catch (error) {
    console.error("Error transcribing audio", error);
    return "[Audio: transcription failed]";
  }
}
