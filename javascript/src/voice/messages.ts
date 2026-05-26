/**
 * Audio message helpers — TS port of `python/scenario/voice/messages.py`.
 *
 * Encodes {@link AudioChunk}s into locally-defined {@link AudioMessageParam}
 * messages (input_audio content parts for any role) and extracts them back out.
 *
 * Per Decision 2(b) from issue #372: this module does NOT import from `openai`.
 * It uses the local {@link AudioMessageParam} superset defined in
 * `./messages.types.ts`, which is structurally compatible with OpenAI's
 * `ChatCompletionMessageParam` for the cases the voice subsystem produces.
 *
 * Audio travels cleanly in any role (user or assistant) — there is no
 * `forceUserRole` workaround (see feature spec line 819-824).
 */

import { AudioChunk, PCM16_SAMPLE_RATE } from "./audio-chunk";
import type {
  AudioMessageParam,
  AudioMessageRole,
  AudioMessageContentPart,
  TextContentPart,
  InputAudioContentPart,
} from "./messages.types";

// ---------------------------------------------------------------------------
// Internal WAV helpers (mirror of python/scenario/voice/messages.py)
// ---------------------------------------------------------------------------

/**
 * Wrap raw PCM16 mono bytes at 24kHz in a minimal RIFF/WAV container.
 *
 * Why inline rather than a dep: the WAV header is ~44 bytes and we control
 * every field, so pulling in `wav` or `node-wav` would be over-engineering
 * for a fixed-format encode.
 */
function pcm16ToWavBytes(pcm: Uint8Array): Uint8Array {
  const numChannels = 1;
  const sampleRate = PCM16_SAMPLE_RATE;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const chunkSize = 36 + dataSize;

  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const uint8 = new Uint8Array(buf);

  // RIFF chunk descriptor
  uint8.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, chunkSize, true); // ChunkSize
  uint8.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"

  // fmt sub-chunk
  uint8.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, numChannels, true); // NumChannels
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, byteRate, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, bitsPerSample, true); // BitsPerSample

  // data sub-chunk
  uint8.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, dataSize, true); // Subchunk2Size
  uint8.set(pcm, 44);

  return uint8;
}

/**
 * Extract raw PCM16 frames from a WAV byte array.
 * Skips the 44-byte standard WAV header and returns the data payload.
 *
 * Note: This assumes a standard 44-byte PCM WAV header. For WAVs with
 * non-standard headers (e.g., 'LIST' chunks), this is a best-effort extraction.
 * For the voice SDK's own produced WAVs this is always correct.
 */
function wavBytesToPcm16(wav: Uint8Array): Uint8Array {
  // Scan for the "data" marker rather than assuming fixed 44-byte header.
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  for (let i = 12; i < wav.length - 8; i++) {
    if (
      wav[i] === 0x64 && // 'd'
      wav[i + 1] === 0x61 && // 'a'
      wav[i + 2] === 0x74 && // 't'
      wav[i + 3] === 0x61 // 'a'
    ) {
      const dataSize = view.getUint32(i + 4, true);
      const start = i + 8;
      return wav.slice(start, start + dataSize);
    }
  }
  // Fallback: assume 44-byte header if marker not found.
  return wav.slice(44);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Turn an {@link AudioChunk} into an {@link AudioMessageParam}.
 *
 * The content is a list with an `input_audio` part carrying base64-encoded WAV.
 * If the chunk has a transcript, it is added as a `text` part BEFORE the audio —
 * this lets the judge's text-only path still read the content.
 *
 * Audio travels cleanly in any role (user or assistant) — no `forceUserRole`.
 *
 * @param chunk - The audio chunk to wrap.
 * @param role  - The message role. Defaults to `"user"`.
 * @returns An {@link AudioMessageParam} ready for the conversation bus.
 */
export function createAudioMessage(
  chunk: AudioChunk,
  role: AudioMessageRole = "user"
): AudioMessageParam {
  const wavBytes = pcm16ToWavBytes(chunk.data);
  // Convert Uint8Array to base64 via Buffer (Node.js environment assumed by voice SDK).
  const b64 = Buffer.from(wavBytes).toString("base64");

  const audioPart: InputAudioContentPart = {
    type: "input_audio",
    input_audio: { data: b64, format: "wav" },
  };

  const parts: AudioMessageContentPart[] = [];

  if (chunk.transcript) {
    const textPart: TextContentPart = { type: "text", text: chunk.transcript };
    parts.push(textPart);
  }

  parts.push(audioPart);

  return { role, content: parts };
}

/**
 * Pull the first audio chunk out of an {@link AudioMessageParam}-shaped object.
 *
 * Returns `null` if the message has no audio content part. Accepts both
 * `input_audio` (OpenAI API convention) and `audio` (alternate providers).
 *
 * @param message - Any message object. Accepts plain records so callers don't
 *                  need to cast to `AudioMessageParam` first.
 * @returns The first {@link AudioChunk} found, or `null`.
 */
export function extractAudio(message: unknown): AudioChunk | null {
  if (!message || typeof message !== "object") return null;
  const msg = message as Record<string, unknown>;
  const content = msg["content"];
  if (!Array.isArray(content)) return null;

  let transcript: string | undefined;

  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;

    if (p["type"] === "text" && typeof p["text"] === "string") {
      transcript = p["text"] || transcript;
      continue;
    }

    if (p["type"] === "input_audio" || p["type"] === "audio") {
      const dataObj =
        (p["input_audio"] as Record<string, unknown> | undefined) ??
        (p["audio"] as Record<string, unknown> | undefined) ??
        {};
      const b64 = typeof dataObj["data"] === "string" ? dataObj["data"] : null;
      if (!b64) continue;

      const raw = new Uint8Array(Buffer.from(b64, "base64"));
      // Detect WAV by RIFF header magic bytes.
      const isWav =
        raw[0] === 0x52 && // 'R'
        raw[1] === 0x49 && // 'I'
        raw[2] === 0x46 && // 'F'
        raw[3] === 0x46; // 'F'

      const pcm = isWav ? wavBytesToPcm16(raw) : raw;
      return new AudioChunk({ data: pcm, transcript });
    }
  }

  return null;
}

/**
 * Returns `true` if the message contains any audio content part.
 *
 * @param message - Any message-shaped object.
 */
export function messageHasAudio(message: unknown): boolean {
  return extractAudio(message) !== null;
}
