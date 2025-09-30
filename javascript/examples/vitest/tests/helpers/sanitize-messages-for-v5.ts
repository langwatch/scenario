import { CoreMessage } from "ai";
import OpenAI from "openai";

/**
 * Sanitizes messages for AI SDK v5 compatibility by converting audio file parts to text
 */
export async function sanitizeMessagesForV5(
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
              return await transcribeAudio(part.data as string);
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

async function transcribeAudio(audioData: string): Promise<string> {
  try {
    const openaiClient = new OpenAI();
    const response = await openaiClient.audio.transcriptions.create({
      model: "whisper-1",
      file: new File([Buffer.from(audioData, "base64")], "audio.wav", {
        type: "audio/wav",
      }),
      language: "en",
    });
    console.log("Transcription response", response);
    return response.text;
  } catch (error) {
    console.error("Error transcribing audio", error);
    return "[Audio: transcription failed]";
  }
}
