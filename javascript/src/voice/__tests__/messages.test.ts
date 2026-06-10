/**
 * Unit tests for `javascript/src/voice/messages.ts` — the SOLE audio
 * message encoder/extractor (Gap #3, EDR §4.2).
 *
 * Offline, no API keys. Covers `createAudioMessage`, `extractAudio`,
 * `messageHasAudio`, `hasAudio`, `extractTranscript`, the canonical AI-SDK
 * `file`-part shape, and the round-trip guard for the Gap #3 LIVE BUG (one
 * producer, one extractor — no WAV-vs-PCM16 format split).
 */

import { describe, it, expect } from "vitest";

import { AudioChunk, PCM16_SAMPLE_RATE } from "../audio-chunk";
import {
  createAudioMessage,
  extractAudio,
  messageHasAudio,
  hasAudio,
  extractTranscript,
  AUDIO_PCM16_MEDIA_TYPE,
} from "../messages";

/** Create a minimal PCM16 AudioChunk with the given number of samples. */
function makeChunk(samples: number, opts?: { transcript?: string }): AudioChunk {
  const data = new Uint8Array(samples * 2); // 2 bytes per PCM16 sample
  return new AudioChunk({ data, ...opts });
}

/** Return a 1-second silent chunk (24000 samples). */
function oneSecond(transcript?: string): AudioChunk {
  return makeChunk(PCM16_SAMPLE_RATE, { transcript });
}

// ---------------------------------------------------------------------------
// createAudioMessage — canonical AI-SDK `file` part
// ---------------------------------------------------------------------------

describe("createAudioMessage", () => {
  it("returns a message with role 'user' by default", () => {
    expect(createAudioMessage(oneSecond()).role).toBe("user");
  });

  it("respects an explicit role override (assistant)", () => {
    expect(createAudioMessage(oneSecond(), "assistant").role).toBe("assistant");
  });

  it("content is a non-empty array", () => {
    const msg = createAudioMessage(oneSecond());
    expect(Array.isArray(msg.content)).toBe(true);
    expect((msg.content as unknown[]).length).toBeGreaterThan(0);
  });

  it("emits a `file` part with mediaType audio/pcm16 (raw PCM16, NOT WAV)", () => {
    const msg = createAudioMessage(oneSecond());
    const parts = msg.content as Array<Record<string, unknown>>;
    const audioPart = parts.find((p) => p["type"] === "file");
    expect(audioPart).toBeDefined();
    expect(audioPart!["mediaType"]).toBe(AUDIO_PCM16_MEDIA_TYPE);
    expect(audioPart!["mediaType"]).toBe("audio/pcm16");

    // Base64 string payload; decoded bytes must NOT start with RIFF (raw PCM16).
    const decoded = Buffer.from(audioPart!["data"] as string, "base64");
    expect(decoded.slice(0, 4).toString("ascii")).not.toBe("RIFF");
  });

  it("when chunk has transcript, text part precedes audio part", () => {
    const msg = createAudioMessage(oneSecond("hello world"));
    const parts = msg.content as Array<Record<string, unknown>>;
    expect(parts[0]["type"]).toBe("text");
    expect(parts[0]["text"]).toBe("hello world");
    expect(parts[1]["type"]).toBe("file");
  });

  it("when chunk has no transcript, no text part is added", () => {
    const parts = createAudioMessage(oneSecond()).content as Array<
      Record<string, unknown>
    >;
    expect(parts.find((p) => p["type"] === "text")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractAudio — round-trip (the Gap #3 regression guard)
// ---------------------------------------------------------------------------

describe("extractAudio", () => {
  it("returns null for non-object input", () => {
    expect(extractAudio(null)).toBeNull();
    expect(extractAudio(undefined)).toBeNull();
    expect(extractAudio("string")).toBeNull();
    expect(extractAudio(42)).toBeNull();
  });

  it("returns null when content is not an array", () => {
    expect(extractAudio({ role: "user", content: "text" })).toBeNull();
  });

  it("returns null when no audio part in content", () => {
    expect(
      extractAudio({ role: "user", content: [{ type: "text", text: "hi" }] }),
    ).toBeNull();
  });

  it("round-trips encode → extract preserving the exact PCM payload", () => {
    const data = new Uint8Array(8).fill(0x5a); // 4 samples
    const chunk = new AudioChunk({ data });
    const extracted = extractAudio(createAudioMessage(chunk));
    expect(extracted).not.toBeNull();
    expect(Array.from(extracted!.data)).toEqual(Array.from(data));
  });

  it("round-trips the transcript alongside the audio", () => {
    const extracted = extractAudio(createAudioMessage(oneSecond("round-trip")));
    expect(extracted).toBeInstanceOf(AudioChunk);
    expect(extracted!.transcript).toBe("round-trip");
  });

  it("preserves recognizable byte values through encode/extract", () => {
    const data = new Uint8Array([0x01, 0x00, 0x02, 0x00]); // 2 samples
    const extracted = extractAudio(createAudioMessage(new AudioChunk({ data })));
    expect(Array.from(extracted!.data)).toEqual([0x01, 0x00, 0x02, 0x00]);
  });

  it("still decodes a legacy WAV-wrapped input_audio part (adapter-edge tolerance)", () => {
    // RIFF/WAV header (44 bytes) + 4 data bytes → extractor strips the header.
    const pcm = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const header = new Uint8Array(44);
    header.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    header.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
    new DataView(header.buffer).setUint32(40, pcm.length, true);
    const wav = new Uint8Array(48);
    wav.set(header, 0);
    wav.set(pcm, 44);
    const b64 = Buffer.from(wav).toString("base64");
    const msg = {
      role: "user",
      content: [{ type: "input_audio", input_audio: { data: b64, format: "wav" } }],
    };
    expect(Array.from(extractAudio(msg)!.data)).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it("returns the first audio part when multiple exist", () => {
    const a = createAudioMessage(makeChunk(2)).content as unknown[];
    const msg = { role: "user", content: [...a, ...a] };
    expect(extractAudio(msg)).toBeInstanceOf(AudioChunk);
  });

  it("returns null when the file part has no string/Uint8Array data", () => {
    const msg = {
      role: "user",
      content: [{ type: "file", mediaType: "audio/pcm16", data: 123 }],
    };
    expect(extractAudio(msg)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gap #3 cross-producer guard — the realtime path & messages.ts agree
// ---------------------------------------------------------------------------

describe("Gap #3 — single format across producers", () => {
  it("extracts audio from the realtime-style `file` part (audio/pcm16)", () => {
    // Shape emitted by realtime/response-formatter.ts:22.
    const pcm = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
    const realtimeMsg = {
      role: "assistant",
      content: [
        { type: "text", text: "from realtime" },
        { type: "file", mediaType: "audio/pcm16", data: Buffer.from(pcm).toString("base64") },
      ],
    };
    const extracted = extractAudio(realtimeMsg);
    expect(extracted).not.toBeNull();
    expect(Array.from(extracted!.data)).toEqual([0x10, 0x20, 0x30, 0x40]);
    expect(extracted!.transcript).toBe("from realtime");
  });

  it("createAudioMessage output is itself a valid realtime-shape `file` message", () => {
    const msg = createAudioMessage(makeChunk(3, { transcript: "t" }));
    const parts = msg.content as Array<Record<string, unknown>>;
    const filePart = parts.find((p) => p["type"] === "file")!;
    // Same discriminant + media-type prefix the judge's transcript builder reads.
    expect(filePart["type"]).toBe("file");
    expect((filePart["mediaType"] as string).startsWith("audio/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// messageHasAudio / hasAudio / extractTranscript
// ---------------------------------------------------------------------------

describe("messageHasAudio / hasAudio", () => {
  it("messageHasAudio: true for a createAudioMessage message", () => {
    expect(messageHasAudio(createAudioMessage(oneSecond()))).toBe(true);
  });

  it("messageHasAudio: false for a plain text string message", () => {
    expect(messageHasAudio({ role: "user", content: "hello" })).toBe(false);
  });

  it("messageHasAudio: false for null / undefined", () => {
    expect(messageHasAudio(null)).toBe(false);
    expect(messageHasAudio(undefined)).toBe(false);
  });

  it("hasAudio: true only for the canonical `file` audio part", () => {
    expect(hasAudio(createAudioMessage(oneSecond()))).toBe(true);
    expect(
      hasAudio({ role: "user", content: [{ type: "text", text: "x" }] }),
    ).toBe(false);
  });
});

describe("extractTranscript", () => {
  it("returns the leading text part's text", () => {
    expect(extractTranscript(createAudioMessage(oneSecond("spoken")))).toBe(
      "spoken",
    );
  });

  it("returns undefined when there is no text part", () => {
    expect(extractTranscript(createAudioMessage(oneSecond()))).toBeUndefined();
  });
});
