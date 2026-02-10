/**
 * Audio Conversation Utilities
 *
 * This module provides utilities for extracting, processing, and saving audio data
 * from scenario test conversations. It enables you to:
 * - Extract audio segments from multi-turn conversations
 * - Concatenate multiple audio segments into a single file
 * - Save full conversations as playable audio files for review
 *
 * Useful for debugging audio-based agent interactions and creating conversation recordings.
 */
import * as fs from "fs";
import * as path from "path";
import { ScenarioResult } from "@langwatch/scenario";
import { ModelMessage } from "ai";
import { isAudioFilePart } from "./convert-core-messages-to-openai";

/**
 * Audio segment extracted from a conversation message
 */
interface AudioSegment {
  /** Base64-encoded audio data */
  data: string;
  /** Speaker identifier (User or Agent) */
  speaker: string;
  /** Message index used as timestamp */
  timestamp: number;
}

/**
 * Extracts audio from scenario messages and saves as a concatenated audio file
 *
 * This function:
 * 1. Scans all messages for audio content
 * 2. Extracts and decodes base64 audio data
 * 3. Concatenates all segments in conversation order
 * 4. Saves the result as a single WAV file
 *
 * @param result - The scenario result containing the conversation messages
 * @param outputFilePath - Path where the concatenated audio file should be saved
 * @param keepTempFiles - If true, retains temporary segment files for debugging
 */
export async function saveConversationAudio(
  result: Pick<ScenarioResult, "messages">,
  outputFilePath: string,
  keepTempFiles: boolean = false
): Promise<void> {
  const audioSegments: AudioSegment[] = [];

  // Extract audio data from all messages
  result.messages.forEach((message: ModelMessage, index: number) => {
    if (message.content && Array.isArray(message.content)) {
      message.content.forEach((content: unknown) => {
        if (isAudioFilePart(content)) {
          // Determine speaker based on message role
          const speaker = message.role === "user" ? "User" : "Agent";

          audioSegments.push({
            data: content.data,
            speaker: speaker,
            timestamp: index, // Use message index as simple timestamp
          });
        }
      });
    }
  });

  if (audioSegments.length === 0) {
    console.log("No audio data found in conversation");
    return;
  }

  console.log(`Found ${audioSegments.length} audio segments`);

  // Create output directory if it doesn't exist
  const outputDir = path.dirname(outputFilePath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Create individual audio files first
  const tempDir = path.join(process.cwd(), "temp_audio");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const segmentFiles: string[] = [];

  // Save each audio segment as a temporary file for concatenation
  for (let i = 0; i < audioSegments.length; i++) {
    const segment = audioSegments[i];
    const segmentPath = path.join(
      tempDir,
      `segment_${i}_${segment.speaker.toLowerCase()}.wav`
    );

    // Decode base64 audio data and write to file
    const audioBuffer = Buffer.from(segment.data, "base64");
    fs.writeFileSync(segmentPath, audioBuffer);
    segmentFiles.push(segmentPath);

    console.log(`Saved ${segment.speaker} segment ${i + 1} to ${segmentPath}`);
  }

  // Simple concatenation approach for WAV files
  // Note: This is a basic implementation - for production use, consider using ffmpeg
  await concatenateWavFiles(segmentFiles, outputFilePath);

  // Clean up temporary files
  segmentFiles.forEach((file) => {
    try {
      if (!keepTempFiles) {
        fs.unlinkSync(file);
      }
    } catch (error) {
      console.warn(`Failed to delete temporary file ${file}:`, error);
    }
  });

  // Clean up temp directory if empty
  try {
    fs.rmdirSync(tempDir);
  } catch {
    // Directory might not be empty or might not exist, ignore
  }

  console.log(`📻 Full conversation saved to: ${outputFilePath}`);
}

/**
 * Concatenates multiple WAV files into a single output file
 *
 * This is a basic implementation that:
 * - Reuses the header from the first file
 * - Strips headers from subsequent files
 * - Concatenates all audio data
 * - Updates the header with the new total size
 *
 * WARNING: This is a simple implementation that works for basic WAV files with identical
 * format parameters (sample rate, bit depth, channels). For production use or files with
 * different formats, consider using ffmpeg or a proper audio processing library.
 *
 * @param inputFiles - Array of WAV file paths to concatenate
 * @param outputFile - Output file path for concatenated audio
 */
export async function concatenateWavFiles(
  inputFiles: string[],
  outputFile: string
): Promise<void> {
  if (inputFiles.length === 0) {
    throw new Error("No input files provided");
  }

  if (inputFiles.length === 1) {
    // Single file, just copy it
    fs.copyFileSync(inputFiles[0], outputFile);
    return;
  }

  // Read first file to get header (WAV header contains format info)
  const firstFile = fs.readFileSync(inputFiles[0]);
  const wavHeader = firstFile.slice(0, 44); // Standard WAV header is 44 bytes

  // Collect all audio data (skip headers from subsequent files to avoid duplication)
  const audioDataSegments: Buffer[] = [];
  let totalDataSize = 0;

  for (const file of inputFiles) {
    const fileBuffer = fs.readFileSync(file);
    const audioData = fileBuffer.slice(44); // Skip the 44-byte WAV header
    audioDataSegments.push(audioData);
    totalDataSize += audioData.length;
  }

  // Create new header with updated file size information
  const newHeader = Buffer.from(wavHeader);

  // Update RIFF chunk size at offset 4 (total file size - 8 bytes)
  const newChunkSize = totalDataSize + 36;
  newHeader.writeUInt32LE(newChunkSize, 4);

  // Update data chunk size at offset 40 (actual audio data size)
  newHeader.writeUInt32LE(totalDataSize, 40);

  // Write concatenated file
  const outputBuffer = Buffer.concat([newHeader, ...audioDataSegments]);
  fs.writeFileSync(outputFile, outputBuffer);
}

/**
 * Extracts audio segments from scenario result for programmatic analysis
 *
 * Unlike saveConversationAudio, this function returns the segments as data
 * rather than saving them to disk. Useful for:
 * - Analyzing audio content programmatically
 * - Counting audio exchanges
 * - Processing segments individually
 *
 * @param result - The scenario result containing the conversation messages
 * @returns Array of audio segments with metadata (speaker, data, timestamp)
 */
export function getAudioSegments(result: ScenarioResult): AudioSegment[] {
  const audioSegments: AudioSegment[] = [];

  result.messages.forEach((message: ModelMessage, index: number) => {
    if (message.content && Array.isArray(message.content)) {
      message.content.forEach((content: unknown) => {
        if (isAudioFilePart(content)) {
          const speaker = message.role === "user" ? "User" : "Agent";

          audioSegments.push({
            data: content.data,
            speaker: speaker,
            timestamp: index,
          });
        }
      });
    }
  });

  return audioSegments;
}
