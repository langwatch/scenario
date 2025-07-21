import * as fs from "fs";
import * as path from "path";
import { ScenarioResult } from "@langwatch/scenario";
import { CoreMessage } from "ai";
import { isAudioFilePart } from "./convert-core-messages-to-openai";

/**
 * Audio segment extracted from a conversation message
 */
interface AudioSegment {
  data: string;
  speaker: string;
  timestamp: number;
}

/**
 * Utility function to extract audio data from scenario messages and save as concatenated audio file
 * @param result - The scenario result containing the conversation messages
 * @param outputFilePath - Path where the concatenated audio file should be saved
 */
export async function saveConversationAudio(
  result: ScenarioResult,
  outputFilePath: string,
  // Useful for debugging
  keepTempFiles: boolean = false
): Promise<void> {
  const audioSegments: AudioSegment[] = [];

  // Extract audio data from all messages
  result.messages.forEach((message: CoreMessage, index: number) => {
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

  for (let i = 0; i < audioSegments.length; i++) {
    const segment = audioSegments[i];
    const segmentPath = path.join(
      tempDir,
      `segment_${i}_${segment.speaker.toLowerCase()}.wav`
    );

    // Decode base64 and save
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
 * Basic WAV file concatenation
 * WARNING: This is a simple implementation that works for basic WAV files
 * For production use, consider using ffmpeg or a proper audio processing library
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

  // Read first file to get header
  const firstFile = fs.readFileSync(inputFiles[0]);
  const wavHeader = firstFile.slice(0, 44); // Standard WAV header is 44 bytes

  // Collect all audio data (skip headers from subsequent files)
  const audioDataSegments: Buffer[] = [];
  let totalDataSize = 0;

  for (const file of inputFiles) {
    const fileBuffer = fs.readFileSync(file);
    const audioData = fileBuffer.slice(44); // Skip WAV header
    audioDataSegments.push(audioData);
    totalDataSize += audioData.length;
  }

  // Update header with new file size
  const newHeader = Buffer.from(wavHeader);

  // Update chunk size (file size - 8)
  const newChunkSize = totalDataSize + 36;
  newHeader.writeUInt32LE(newChunkSize, 4);

  // Update data chunk size
  newHeader.writeUInt32LE(totalDataSize, 40);

  // Write concatenated file
  const outputBuffer = Buffer.concat([newHeader, ...audioDataSegments]);
  fs.writeFileSync(outputFile, outputBuffer);
}

/**
 * Get audio segments from scenario result for analysis
 * @param result - The scenario result containing the conversation messages
 * @returns Array of audio segments with metadata
 */
export function getAudioSegments(result: ScenarioResult): AudioSegment[] {
  const audioSegments: AudioSegment[] = [];

  result.messages.forEach((message: CoreMessage, index: number) => {
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
