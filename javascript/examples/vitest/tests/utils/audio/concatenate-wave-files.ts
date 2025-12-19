import * as fs from "fs";

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
