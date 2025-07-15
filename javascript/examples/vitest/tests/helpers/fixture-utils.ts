import * as path from "path";

/**
 * Get the fixture audio file path
 * Note: You'll need to add an audio fixture file to the fixtures directory
 * @returns Path to the test audio file
 */
export function getFixturePath(filename: string): string {
  // For this example, we'll assume you have a test audio file
  // You can create a simple WAV file or use any short audio sample
  return path.join(__dirname, "../fixtures", filename);
}
