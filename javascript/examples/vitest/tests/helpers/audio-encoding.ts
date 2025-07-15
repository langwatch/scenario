import * as fs from "fs";

/**
 * Helper function to encode audio file to base64
 * @param filePath - Path to the audio file
 * @returns Base64 encoded audio data
 */
export function encodeAudioToBase64(filePath: string): string {
  const audioBuffer = fs.readFileSync(filePath);
  return Buffer.from(audioBuffer).toString("base64");
}
