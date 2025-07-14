import * as fs from "fs";
import * as path from "path";

/**
 * Helper function to encode audio file to base64
 * @param filePath - Path to the audio file
 * @returns Base64 encoded audio data
 */
export function encodeAudioToBase64(filePath: string): string {
  const audioBuffer = fs.readFileSync(filePath);
  return Buffer.from(audioBuffer).toString("base64");
}

/**
 * Get the fixture audio file path
 * Note: You'll need to add an audio fixture file to the fixtures directory
 * @returns Path to the test audio file
 */
export function getFixtureAudioPath(name: string): string {
  // For this example, we'll assume you have a test audio file
  // You can create a simple WAV file or use any short audio sample
  return path.join(__dirname, "fixtures", name);
}
