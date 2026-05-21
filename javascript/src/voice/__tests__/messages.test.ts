/**
 * Unit tests for `javascript/src/voice/messages.ts`.
 *
 * The messages module is a helper-only module with no BDD scenarios of its
 * own — it is exercised by the simulator (@ts-simulator) and judge (@ts-judge)
 * vitest-cucumber tests. These are plain vitest unit tests covering boundary
 * cases of `createAudioMessage`, `extractAudio`, and `messageHasAudio`.
 *
 * No scenario binding here — no `describeFeature`.
 */

import { describe, it, expect } from "vitest";

import { AudioChunk, PCM16_SAMPLE_RATE } from "../audio-chunk";
import {
  createAudioMessage,
  extractAudio,
  messageHasAudio,
} from "../messages";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal PCM16 AudioChunk with the given number of samples. */
function makeChunk(
  samples: number,
  opts?: { transcript?: string }
): AudioChunk {
  const data = new Uint8Array(samples * 2); // 2 bytes per PCM16 sample
  return new AudioChunk({ data, ...opts });
}

/** Return a 1-second silent chunk (24000 samples). */
function oneSecond(transcript?: string): AudioChunk {
  return makeChunk(PCM16_SAMPLE_RATE, { transcript });
}

// ---------------------------------------------------------------------------
// createAudioMessage
// ---------------------------------------------------------------------------

describe("createAudioMessage", () => {
  it("returns a message with role 'user' by default", () => {
    const msg = createAudioMessage(oneSecond());
    expect(msg.role).toBe("user");
  });

  it("respects an explicit role override (assistant)", () => {
    const msg = createAudioMessage(oneSecond(), "assistant");
    expect(msg.role).toBe("assistant");
  });

  it("content is a non-empty array", () => {
    const msg = createAudioMessage(oneSecond());
    expect(Array.isArray(msg.content)).toBe(true);
    expect(msg.content.length).toBeGreaterThan(0);
  });

  it("content includes an input_audio part with base64 WAV", () => {
    const msg = createAudioMessage(oneSecond());
    const parts = msg.content as Array<Record<string, unknown>>;
    const audioPart = parts.find((p) => p["type"] === "input_audio");
    expect(audioPart).toBeDefined();

    const inputAudio = audioPart!["input_audio"] as Record<string, unknown>;
    expect(inputAudio["format"]).toBe("wav");

    // Should be valid base64 (Buffer.from(..., 'base64') won't throw)
    expect(() =>
      Buffer.from(inputAudio["data"] as string, "base64")
    ).not.toThrow();

    // Decoded bytes should start with RIFF magic bytes
    const decoded = Buffer.from(inputAudio["data"] as string, "base64");
    expect(decoded.slice(0, 4).toString("ascii")).toBe("RIFF");
  });

  it("when chunk has transcript, text part precedes audio part", () => {
    const chunk = oneSecond("hello world");
    const msg = createAudioMessage(chunk);
    const parts = msg.content as Array<Record<string, unknown>>;

    expect(parts[0]["type"]).toBe("text");
    expect(parts[0]["text"]).toBe("hello world");
    expect(parts[1]["type"]).toBe("input_audio");
  });

  it("when chunk has no transcript, no text part is added", () => {
    const chunk = oneSecond(); // no transcript
    const msg = createAudioMessage(chunk);
    const parts = msg.content as Array<Record<string, unknown>>;

    const textPart = parts.find((p) => p["type"] === "text");
    expect(textPart).toBeUndefined();
  });

  it("produces a WAV-encoded byte sequence that decodes back to the original PCM", () => {
    // Fill with recognizable bytes: alternating 0x01 0x02 (LSB, MSB of each sample)
    const data = new Uint8Array(4); // 2 samples
    data[0] = 0x01;
    data[1] = 0x00;
    data[2] = 0x02;
    data[3] = 0x00;
    const chunk = new AudioChunk({ data });
    const msg = createAudioMessage(chunk);

    const parts = msg.content as Array<Record<string, unknown>>;
    const audioPart = parts.find((p) => p["type"] === "input_audio")!;
    const inputAudio = audioPart["input_audio"] as Record<string, unknown>;
    const decoded = Buffer.from(inputAudio["data"] as string, "base64");

    // WAV data section starts at offset 44 (standard PCM WAV header)
    // The 'data' chunk can be found by scanning for the "data" marker.
    const riff = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.length);
    let dataStart = -1;
    for (let i = 12; i < riff.length - 8; i++) {
      if (
        riff[i] === 0x64 && riff[i + 1] === 0x61 &&
        riff[i + 2] === 0x74 && riff[i + 3] === 0x61
      ) {
        dataStart = i + 8;
        break;
      }
    }
    expect(dataStart).toBeGreaterThan(0);
    expect(Array.from(riff.slice(dataStart, dataStart + 4))).toEqual([
      0x01, 0x00, 0x02, 0x00,
    ]);
  });
});

// ---------------------------------------------------------------------------
// extractAudio
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
    const msg = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    };
    expect(extractAudio(msg)).toBeNull();
  });

  it("returns an AudioChunk from a createAudioMessage-produced message", () => {
    const original = oneSecond("round-trip");
    const msg = createAudioMessage(original);
    const extracted = extractAudio(msg);

    expect(extracted).toBeInstanceOf(AudioChunk);
    expect(extracted!.transcript).toBe("round-trip");
  });

  it("round-trips PCM data through WAV encoding", () => {
    const data = new Uint8Array(8).fill(0x5a); // 4 samples
    const chunk = new AudioChunk({ data });
    const msg = createAudioMessage(chunk);
    const extracted = extractAudio(msg);

    expect(extracted).not.toBeNull();
    expect(extracted!.data.length).toBe(8);
    expect(Array.from(extracted!.data)).toEqual(Array.from(data));
  });

  it("accepts 'audio' type part (alternate provider convention)", () => {
    const b64 = Buffer.from(new Uint8Array(4)).toString("base64");
    const msg = {
      role: "user",
      content: [
        {
          type: "audio",
          audio: { data: b64, format: "wav" },
        },
      ],
    };
    // Not a WAV buffer (no RIFF magic), so raw pass-through
    const extracted = extractAudio(msg);
    expect(extracted).toBeInstanceOf(AudioChunk);
  });

  it("extracts text transcript from a preceding text part", () => {
    const b64 = Buffer.from(new Uint8Array(4)).toString("base64");
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "the transcript" },
        {
          type: "input_audio",
          input_audio: { data: b64, format: "wav" },
        },
      ],
    };
    const extracted = extractAudio(msg);
    expect(extracted!.transcript).toBe("the transcript");
  });

  it("returns the first audio part when multiple exist", () => {
    const b64 = Buffer.from(new Uint8Array(4)).toString("base64");
    const msg = {
      role: "user",
      content: [
        { type: "input_audio", input_audio: { data: b64, format: "wav" } },
        { type: "input_audio", input_audio: { data: b64, format: "wav" } },
      ],
    };
    expect(extractAudio(msg)).toBeInstanceOf(AudioChunk);
  });

  it("returns null when input_audio has no data field", () => {
    const msg = {
      role: "user",
      content: [{ type: "input_audio", input_audio: { format: "wav" } }],
    };
    expect(extractAudio(msg)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// messageHasAudio
// ---------------------------------------------------------------------------

describe("messageHasAudio", () => {
  it("returns true for a message produced by createAudioMessage", () => {
    const msg = createAudioMessage(oneSecond());
    expect(messageHasAudio(msg)).toBe(true);
  });

  it("returns false for a plain text message", () => {
    const msg = { role: "user", content: "hello" };
    expect(messageHasAudio(msg)).toBe(false);
  });

  it("returns false for null / undefined", () => {
    expect(messageHasAudio(null)).toBe(false);
    expect(messageHasAudio(undefined)).toBe(false);
  });

  it("returns true for a message with an 'audio' type part", () => {
    const b64 = Buffer.from(new Uint8Array(4)).toString("base64");
    const msg = {
      role: "assistant",
      content: [{ type: "audio", audio: { data: b64, format: "wav" } }],
    };
    expect(messageHasAudio(msg)).toBe(true);
  });
});
