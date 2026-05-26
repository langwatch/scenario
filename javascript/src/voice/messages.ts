/**
 * Audio message gateway — the SOLE runtime `AudioChunk ↔ ModelMessage`
 * encoder/extractor. The ONE place the in-message audio format is built and
 * parsed (EDR §4.2, Gap #3).
 *
 * Format: the canonical {@link AudioChunk} (raw PCM16 / 24 kHz / mono) is
 * carried as an **AI-SDK `file` part** — `{ type: "file", mediaType:
 * "audio/pcm16", data: <base64> }` — with the transcript (when present) as a
 * preceding `{ type: "text" }` part so the judge's text-only path still
 * reads the content. This matches what `realtime/response-formatter.ts`
 * already emits and what `judge-utils.ts#buildTranscriptFromMessages`
 * already truncates.
 *
 * Why one encoder/extractor: before this, two producers disagreed —
 * `messages.ts` wrapped PCM16 in a WAV container tagged `format:"wav"`,
 * while `adapter.runtime.ts` emitted raw PCM16 tagged `format:"pcm16"`, both
 * under the OpenAI `input_audio` convention. Their paired extractors decoded
 * by tag, so cross-feeding mis-decoded a WAV header as audio samples (the
 * Gap #3 LIVE BUG). Now there is one raw-PCM16 `file`-part encoder and one
 * extractor; OpenAI `input_audio`/`audio` shapes stay at the adapter edge.
 *
 * No STT/TTS, no provider-native shapes, no state.
 */

import { AudioChunk } from "./audio-chunk";
import type {
  AudioFilePart,
  AudioMessage,
  AudioMessageRole,
} from "./messages.types";
import type { ModelMessage, TextPart } from "ai";

/** Media type of the canonical in-message audio part (raw PCM16). */
export const AUDIO_PCM16_MEDIA_TYPE = "audio/pcm16" as const;

// ---------------------------------------------------------------------------
// base64 helpers (Node Buffer when available, browser btoa/atob fallback)
// ---------------------------------------------------------------------------

function toBase64(data: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]!);
  return btoa(binary);
}

function fromBase64(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(s, "base64"));
  }
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Strip a 44-byte standard PCM WAV header (scanning for the `data` chunk)
 * so a legacy WAV-wrapped payload still decodes to raw PCM16. New payloads
 * are raw PCM16 and skip this entirely (no RIFF magic).
 */
function wavBytesToPcm16(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  for (let i = 12; i < wav.length - 8; i++) {
    if (wav[i] === 0x64 && wav[i + 1] === 0x61 && wav[i + 2] === 0x74 && wav[i + 3] === 0x61) {
      const dataSize = view.getUint32(i + 4, true);
      const start = i + 8;
      return wav.slice(start, start + dataSize);
    }
  }
  return wav.slice(44);
}

/** Decode an audio payload to raw PCM16 — unwraps a WAV container if present. */
function decodePcm16(b64: string): Uint8Array {
  const raw = fromBase64(b64);
  const isWav =
    raw[0] === 0x52 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x46; // "RIFF"
  return isWav ? wavBytesToPcm16(raw) : raw;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the canonical audio {@link ModelMessage} from an {@link AudioChunk}.
 *
 * The content is `[textPart?, fileAudioPart]`: a raw-PCM16 AI-SDK `file`
 * part (`mediaType: "audio/pcm16"`), preceded by a transcript text part when
 * the chunk carries one. Audio travels cleanly in any role — no
 * `forceUserRole`.
 *
 * @param chunk - The audio chunk to wrap.
 * @param role  - The message role. Defaults to `"user"`.
 */
export function createAudioMessage(
  chunk: AudioChunk,
  role: AudioMessageRole = "user",
): AudioMessage {
  const audioPart: AudioFilePart = {
    type: "file",
    mediaType: AUDIO_PCM16_MEDIA_TYPE,
    data: toBase64(chunk.data),
  };

  const content: Array<TextPart | AudioFilePart> = [];
  if (chunk.transcript) {
    content.push({ type: "text", text: chunk.transcript });
  }
  content.push(audioPart);

  // The AI-SDK ModelMessage role/content unions are stricter per-role than
  // our "any role carries audio" model; the file+text part array is valid at
  // runtime for user/assistant. Cast keeps the public return type ModelMessage.
  return { role, content } as unknown as AudioMessage;
}

function getContentParts(message: unknown): Array<Record<string, unknown>> | null {
  if (!message || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return null;
  return content as Array<Record<string, unknown>>;
}

/**
 * Pull the first audio chunk out of a {@link ModelMessage}-shaped object.
 *
 * Recognizes the canonical AI-SDK `file` part (`mediaType: "audio/*"`), and
 * — for robustness at the transition / adapter edge — the legacy OpenAI
 * `input_audio` and alternate `audio` conventions. Picks up a transcript
 * from a sibling `text` part. Returns `null` if no audio part is present.
 */
export function extractAudio(message: unknown): AudioChunk | null {
  const content = getContentParts(message);
  if (!content) return null;

  let transcript: string | undefined;

  for (const p of content) {
    if (!p || typeof p !== "object") continue;

    if (p["type"] === "text" && typeof p["text"] === "string") {
      transcript = (p["text"] as string) || transcript;
      continue;
    }

    // Canonical: AI-SDK file part with an audio media type.
    if (
      p["type"] === "file" &&
      typeof p["mediaType"] === "string" &&
      (p["mediaType"] as string).startsWith("audio/")
    ) {
      const data = p["data"];
      if (typeof data === "string") {
        return new AudioChunk({ data: decodePcm16(data), transcript });
      }
      if (data instanceof Uint8Array) {
        return new AudioChunk({ data, transcript });
      }
      continue;
    }

    // Legacy adapter-edge shapes (OpenAI input_audio / alternate audio).
    if (p["type"] === "input_audio" || p["type"] === "audio") {
      const dataObj =
        (p["input_audio"] as Record<string, unknown> | undefined) ??
        (p["audio"] as Record<string, unknown> | undefined) ??
        {};
      const b64 = typeof dataObj["data"] === "string" ? (dataObj["data"] as string) : null;
      if (!b64) continue;
      const tx =
        typeof dataObj["transcript"] === "string"
          ? (dataObj["transcript"] as string)
          : transcript;
      return new AudioChunk({ data: decodePcm16(b64), transcript: tx });
    }
  }

  return null;
}

/** Returns `true` if the message contains any audio content part. */
export function messageHasAudio(message: unknown): boolean {
  return extractAudio(message) !== null;
}

/** Returns `true` if the message carries the canonical audio `file` part. */
export function hasAudio(message: unknown): boolean {
  const content = getContentParts(message);
  if (!content) return false;
  return content.some(
    (p) =>
      p &&
      typeof p === "object" &&
      p["type"] === "file" &&
      typeof p["mediaType"] === "string" &&
      (p["mediaType"] as string).startsWith("audio/"),
  );
}

/** Extract the transcript text from a message's leading text part, if any. */
export function extractTranscript(message: unknown): string | undefined {
  const content = getContentParts(message);
  if (!content) return undefined;
  for (const p of content) {
    if (p && typeof p === "object" && p["type"] === "text" && typeof p["text"] === "string") {
      return p["text"] as string;
    }
  }
  return undefined;
}
