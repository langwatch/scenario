import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { AudioResponseEvent } from "@langwatch/scenario";
import { pcm16ToWav } from "./pcm16-to-wav";
import { concatenateWavFiles } from "../../helpers/audio-conversation";

const saveTestAudio = async ({
  collectedAudio,
  outputDir = "test-audio-output",
}: {
  collectedAudio: AudioResponseEvent[];
  outputDir?: string;
}): Promise<void> => {
  if (collectedAudio.length === 0) {
    console.log("No audio collected to save");
    return;
  }

  const fullOutputDir = join(process.cwd(), outputDir);
  mkdirSync(fullOutputDir, { recursive: true });

  // Save individual response files
  const individualFiles: string[] = [];
  collectedAudio.forEach((event, index) => {
    const wavBuffer = pcm16ToWav(event.audio);
    const outputPath = join(fullOutputDir, `response-${index + 1}.wav`);
    writeFileSync(outputPath, wavBuffer);
    individualFiles.push(outputPath);
    console.log(
      `💾 Saved response ${index + 1}: "${event.transcript.substring(
        0,
        50
      )}..." -> ${outputPath}`
    );
  });

  // Concatenate all responses into a single file
  const concatenatedPath = join(fullOutputDir, "full-conversation.wav");
  await concatenateWavFiles(individualFiles, concatenatedPath);
  console.log(
    `✅ Concatenated ${collectedAudio.length} audio responses to ${concatenatedPath}`
  );
  console.log(
    `💡 Note: Playback speed can be adjusted in your audio player (e.g., VLC, QuickTime)`
  );
};

/**
 * Audio output utilities for testing purposes
 *
 * Provides functionality to save and manage audio files from test scenarios
 */
export const AudioUtils = {
  /**
   * Saves collected audio responses to WAV files for testing purposes
   *
   * Creates individual response files and concatenates them into a full conversation
   *
   * @param params - Parameters object
   * @param params.collectedAudio - Array of audio response events to save
   * @param params.outputDir - Directory to save audio files (defaults to "test-audio-output")
   */
  saveTestAudio,
  concatenateWavFiles,
};
