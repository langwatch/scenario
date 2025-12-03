/**
 * Text-to-speech utility using OpenAI TTS API.
 */
import OpenAI from "openai";
import type { AudioData, TextToSpeechOptions, Voice } from "./types";

/**
 * Default voice for TTS.
 */
const DEFAULT_VOICE: Voice = "nova";

/**
 * Default audio format for TTS output.
 */
const DEFAULT_FORMAT = "wav" as const;

/**
 * Converts text to speech using OpenAI TTS API.
 *
 * @param text - Text to convert to speech.
 * @param options - TTS options including voice and format.
 * @returns AudioData with the synthesized audio.
 */
export async function textToSpeech(
  text: string,
  options?: TextToSpeechOptions
): Promise<AudioData> {
  const voice = options?.voice ?? DEFAULT_VOICE;
  const format = options?.format ?? DEFAULT_FORMAT;

  const openai = new OpenAI();

  const response = await openai.audio.speech.create({
    model: "tts-1",
    voice,
    input: text,
    response_format: format,
  });

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const data = buffer.toString("base64");

  const mediaType =
    format === "mp3"
      ? "audio/mp3"
      : format === "opus"
        ? "audio/ogg"
        : format === "aac"
          ? "audio/mpeg"
          : format === "flac"
            ? "audio/wav"
            : "audio/wav";

  return {
    data,
    mediaType,
    transcript: text,
  };
}

