/**
 * Converts PCM16 base64 audio data to WAV file format
 *
 * OpenAI Realtime API returns PCM16 audio (16-bit, 24kHz, mono).
 * This function adds WAV headers to make it playable.
 */

/**
 * Converts base64 PCM16 audio to WAV file buffer
 *
 * @param base64Pcm16 - Base64 encoded PCM16 audio data
 * @param sampleRate - Sample rate in Hz (default: 24000 for OpenAI Realtime)
 * @param channels - Number of channels (default: 1 for mono)
 * @param bitsPerSample - Bits per sample (default: 16)
 * @returns Buffer containing WAV file data
 */
export function pcm16ToWav(
  base64Pcm16: string,
  sampleRate: number = 24000,
  channels: number = 1,
  bitsPerSample: number = 16
): Buffer {
  // Decode base64 to PCM16 raw audio data
  const pcmData = Buffer.from(base64Pcm16, "base64");
  const dataSize = pcmData.length;

  // WAV header structure (44 bytes)
  const header = Buffer.alloc(44);

  // RIFF chunk descriptor
  header.write("RIFF", 0); // ChunkID
  header.writeUInt32LE(36 + dataSize, 4); // ChunkSize (file size - 8)
  header.write("WAVE", 8); // Format

  // fmt sub-chunk
  header.write("fmt ", 12); // Subchunk1ID
  header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  header.writeUInt16LE(channels, 22); // NumChannels
  header.writeUInt32LE(sampleRate, 24); // SampleRate
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28); // ByteRate
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32); // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34); // BitsPerSample

  // data sub-chunk
  header.write("data", 36); // Subchunk2ID
  header.writeUInt32LE(dataSize, 40); // Subchunk2Size (data size)

  // Combine header + audio data
  return Buffer.concat([header, pcmData]);
}
