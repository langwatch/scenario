/**
 * ResponseFormatter unit scenarios.
 *
 * Regression guard for the audio-emit format: the OpenAI Realtime API streams
 * headerless PCM16, but the assistant content part persisted to LangWatch must
 * be a browser-playable WAV (`audio/wav` + RIFF header), matching the Python
 * twin (`python/scenario/voice/messages.py`, `format: "wav"`). Emitting raw
 * `audio/pcm16` made the simulations UI render an `[error]` badge instead of an
 * inline audio player.
 */

import { describe, it, expect } from "vitest";

import type { AudioResponseEvent } from "../realtime-event-handler";
import { ResponseFormatter } from "../response-formatter";

/** Minimal 4-sample PCM16 (8 bytes), base64-encoded — stand-in for model audio. */
const PCM16_BASE64 = Buffer.from(
  new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x01, 0x80, 0x10, 0x20]),
).toString("base64");

function audioPart(msg: { content: unknown }): Record<string, unknown> {
  const parts = msg.content as Array<Record<string, unknown>>;
  const part = parts.find((p) => p.type === "file");
  if (!part) throw new Error("no file (audio) part in formatted message");
  return part;
}

describe("ResponseFormatter.formatAudioResponse", () => {
  const formatter = new ResponseFormatter();
  const event: AudioResponseEvent = {
    transcript: "hello there",
    audio: PCM16_BASE64,
  };

  it("emits the audio part as audio/wav, not raw audio/pcm16", () => {
    const part = audioPart(formatter.formatAudioResponse(event));
    expect(part.mediaType).toBe("audio/wav");
    expect(part.mediaType).not.toBe("audio/pcm16");
  });

  it("wraps the PCM in a valid RIFF/WAVE container so a browser can decode it", () => {
    const part = audioPart(formatter.formatAudioResponse(event));
    const bytes = Buffer.from(part.data as string, "base64");
    // RIFF....WAVE magic + a 44-byte canonical PCM header.
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(bytes.length).toBe(44 + 8); // header + the 8 PCM bytes
  });

  it("preserves the transcript as a text part", () => {
    const parts = formatter.formatAudioResponse(event).content as Array<
      Record<string, unknown>
    >;
    const text = parts.find((p) => p.type === "text");
    expect(text?.text).toBe("hello there");
  });
});
