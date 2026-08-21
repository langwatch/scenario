/**
 * Which ElevenLabs surfaces `ELEVENLABS_BASE_URL` moves, and which it must not.
 *
 * A LangWatch AI Gateway fronts one ElevenLabs REST route,
 * `GET /v1/convai/conversation/get-signed-url`. It answers chi's plain
 * `404 page not found` for `/v1/speech-to-text` and
 * `/v1/text-to-speech/{voiceId}` (measured against gateway.langwatch.ai on
 * 2026-08-21). So the variable that points the hosted ConvAI adapter at a
 * gateway would break transcription and synthesis in the same process if the
 * leaves read it too. They take an explicit option instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ELEVENLABS_BASE_URL_ENV,
  ELEVENLABS_CONVAI_API_KEY_ENV,
  normalizeElevenLabsBaseUrl,
  resolveElevenLabsBaseUrl,
  resolveElevenLabsConvAIApiKey,
} from "../elevenlabs-base-url";
import { ElevenLabsSTTProvider } from "../stt/elevenlabs-stt";
import { elevenLabsSynthesizeBytes } from "../tts/elevenlabs-tts";

/** Every base URL a leaf handed to the SDK loader, newest last. */
const loaded = vi.hoisted(() => [] as Array<string | undefined>);

vi.mock("../elevenlabs-sdk", () => ({
  loadElevenLabsClient: (_apiKey: string, baseUrl?: string) => {
    loaded.push(baseUrl);
    return Promise.resolve({
      speechToText: { convert: () => Promise.resolve({ text: "hello" }) },
      textToSpeech: {
        convert: () =>
          Promise.resolve(
            (async function* () {
              yield new Uint8Array([0, 0]);
            })(),
          ),
      },
    });
  },
}));

const saved = process.env[ELEVENLABS_BASE_URL_ENV];

describe("given ELEVENLABS_BASE_URL is set for the hosted ConvAI demos", () => {
  beforeEach(() => {
    loaded.length = 0;
    process.env[ELEVENLABS_BASE_URL_ENV] = "https://gateway.example";
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ELEVENLABS_BASE_URL_ENV];
    else process.env[ELEVENLABS_BASE_URL_ENV] = saved;
  });

  it("moves the surface the gateway fronts", () => {
    expect(resolveElevenLabsBaseUrl()).toBe("https://gateway.example");
  });

  it("leaves speech-to-text on ElevenLabs, because the gateway has no route for it", async () => {
    await new ElevenLabsSTTProvider({ apiKey: "key" }).transcribe({
      data: Buffer.alloc(2),
    } as unknown as Parameters<ElevenLabsSTTProvider["transcribe"]>[0]);

    expect(loaded).toEqual([undefined]);
  });

  it("leaves text-to-speech on ElevenLabs, for the same reason", async () => {
    await elevenLabsSynthesizeBytes("hi", "voice_1", { apiKey: "key" });

    expect(loaded).toEqual([undefined]);
  });

  it("still lets a caller point a leaf somewhere explicitly", async () => {
    await elevenLabsSynthesizeBytes("hi", "voice_1", {
      apiKey: "key",
      baseUrl: "https://proxy.example",
    });

    expect(loaded).toEqual(["https://proxy.example"]);
  });

  it("checks an explicit leaf base URL the same way, so /v1 is caught once", () => {
    expect(() => normalizeElevenLabsBaseUrl("https://proxy.example/v1")).toThrow(
      /must not include \/v1/,
    );
  });
});

/**
 * Which key each ElevenLabs destination gets.
 *
 * The gateway authenticates a LangWatch virtual key, ElevenLabs authenticates
 * an ElevenLabs key, and one process talks to both. One variable would have to
 * be both, so the ConvAI lane has its own.
 */
describe("given a key for the hosted ConvAI adapter", () => {
  const savedConvAI = process.env[ELEVENLABS_CONVAI_API_KEY_ENV];
  const savedVendor = process.env.ELEVENLABS_API_KEY;

  beforeEach(() => {
    delete process.env[ELEVENLABS_CONVAI_API_KEY_ENV];
    delete process.env.ELEVENLABS_API_KEY;
  });

  afterEach(() => {
    if (savedConvAI === undefined) delete process.env[ELEVENLABS_CONVAI_API_KEY_ENV];
    else process.env[ELEVENLABS_CONVAI_API_KEY_ENV] = savedConvAI;
    if (savedVendor === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = savedVendor;
  });

  it("prefers ELEVENLABS_CONVAI_API_KEY, which is what pairs with a gateway", () => {
    process.env[ELEVENLABS_CONVAI_API_KEY_ENV] = "vk-lw-test";
    process.env.ELEVENLABS_API_KEY = "sk_vendor";

    expect(resolveElevenLabsConvAIApiKey()).toBe("vk-lw-test");
  });

  it("falls back to ELEVENLABS_API_KEY, so an unconfigured run is unchanged", () => {
    process.env.ELEVENLABS_API_KEY = "sk_vendor";

    expect(resolveElevenLabsConvAIApiKey()).toBe("sk_vendor");
  });

  it("lets an explicit key win over both", () => {
    process.env[ELEVENLABS_CONVAI_API_KEY_ENV] = "vk-lw-test";

    expect(resolveElevenLabsConvAIApiKey("sk_explicit")).toBe("sk_explicit");
  });

  it("skips a blank candidate rather than shadowing a real key with a 401", () => {
    // A variable set to a stray space is truthy. Stopping there would present
    // whitespace as the credential and fail the mint for no visible reason.
    process.env[ELEVENLABS_CONVAI_API_KEY_ENV] = "  ";
    process.env.ELEVENLABS_API_KEY = "sk_vendor";

    expect(resolveElevenLabsConvAIApiKey("")).toBe("sk_vendor");
  });

  it("reports no key when every candidate is blank", () => {
    process.env[ELEVENLABS_CONVAI_API_KEY_ENV] = " ";

    expect(resolveElevenLabsConvAIApiKey()).toBe("");
  });
});
