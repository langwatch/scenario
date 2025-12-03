/**
 * Audio utility functions for loading, encoding, and converting audio.
 */
import * as fs from "fs";
import * as path from "path";
import type { AudioData, AudioMimeType } from "./types";

/**
 * Detects the MIME type from a file extension.
 *
 * @param filePath - Path to the audio file.
 * @returns The detected MIME type.
 */
export function detectMimeType(filePath: string): AudioMimeType {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, AudioMimeType> = {
    ".wav": "audio/wav",
    ".mp3": "audio/mp3",
    ".mpeg": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".webm": "audio/webm",
    ".pcm": "audio/pcm",
  };
  return mimeTypes[ext] ?? "audio/wav";
}

/**
 * Loads audio from a file and returns AudioData.
 *
 * @param filePath - Path to the audio file.
 * @returns AudioData with base64-encoded content.
 */
export function audioFromFile(filePath: string): AudioData {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  const buffer = fs.readFileSync(absolutePath);
  const data = buffer.toString("base64");
  const mediaType = detectMimeType(filePath);

  return { data, mediaType };
}

/**
 * Creates AudioData from a base64 string.
 *
 * @param data - Base64-encoded audio data.
 * @param mediaType - Media type (MIME type) of the audio.
 * @returns AudioData object.
 */
export function audioFromBase64(
  data: string,
  mediaType: AudioMimeType = "audio/wav"
): AudioData {
  return { data, mediaType };
}

/**
 * Creates AudioData from a Buffer.
 *
 * @param buffer - Audio data buffer.
 * @param mediaType - Media type (MIME type) of the audio.
 * @returns AudioData object.
 */
export function audioFromBuffer(
  buffer: Buffer,
  mediaType: AudioMimeType = "audio/wav"
): AudioData {
  return {
    data: buffer.toString("base64"),
    mediaType,
  };
}

/**
 * Converts AudioData to a base64 data URI.
 *
 * @param audio - AudioData to convert.
 * @returns Data URI string.
 */
export function audioToDataUri(audio: AudioData): string {
  return `data:${audio.mediaType};base64,${audio.data}`;
}
