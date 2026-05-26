/**
 * ElevenLabs TTS leaf — the `elevenlabs/<voiceId>` backend (Gap #10).
 *
 * Symmetric with {@link OpenAISTTProvider}/`elevenlabs-stt.ts`: a single home
 * for ElevenLabs synthesis so `voice="elevenlabs/..."` resolves through the
 * TTS registry instead of being buried in `adapters/composable.ts`. The
 * composable agent consumes this leaf for its EL path (de-dup, Gap #5).
 *
 * Wire: `client.textToSpeech.convert(voiceId, { model_id: eleven_v3,
 * output_format: "pcm_24000" })` → raw PCM16/24 kHz mono, matching the
 * canonical {@link AudioChunk}.
 *
 * Registered under the `elevenlabs` prefix by `tts/index.ts` (side effect).
 */
import { Buffer } from "node:buffer";

import { ElevenLabsClient } from "elevenlabs";

import { ELEVENLABS_TTS_MODEL } from "../voice-models";
import type { TTSCallable } from "./tts";

/** Factory for the ElevenLabs SDK client — injectable for tests. */
export type ElevenLabsClientFactory = (apiKey: string) => ElevenLabsClient;

/** Construction / per-call options for {@link ElevenLabsTtsProvider}. */
export interface ElevenLabsTtsOptions {
  /** API key for ElevenLabs. Falls back to `process.env.ELEVENLABS_API_KEY`. */
  apiKey?: string;
  /** Test seam — override the SDK client constructor. */
  clientFactory?: ElevenLabsClientFactory;
}

const defaultClientFactory: ElevenLabsClientFactory = (apiKey) =>
  new ElevenLabsClient({ apiKey });

/**
 * Synthesize `text` to raw PCM16/24 kHz bytes via the ElevenLabs SDK.
 *
 * Standalone so both the registry callable and the composable agent's
 * `ttsOptions` test seam share one implementation.
 */
export async function elevenLabsSynthesizeBytes(
  text: string,
  voiceId: string,
  options: ElevenLabsTtsOptions = {},
): Promise<Uint8Array> {
  const apiKey = options.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "";
  const factory = options.clientFactory ?? defaultClientFactory;
  const client = factory(apiKey);
  const stream = await client.textToSpeech.convert(voiceId, {
    text,
    model_id: ELEVENLABS_TTS_MODEL,
    output_format: "pcm_24000",
  });
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * ElevenLabs TTS provider. Holds an optional API key + client factory so a
 * composed agent can inject a test client; the registry uses the env key.
 */
export class ElevenLabsTtsProvider {
  readonly prefix = "elevenlabs";
  private readonly options: ElevenLabsTtsOptions;

  constructor(options: ElevenLabsTtsOptions = {}) {
    this.options = options;
  }

  /** `(text, voiceId) => PCM16/24kHz bytes`, bound to this provider's options. */
  readonly synth: TTSCallable = (text, voiceId) =>
    elevenLabsSynthesizeBytes(text, voiceId, this.options);
}

/** Registry callable — uses the env API key (the `elevenlabs/...` router path). */
export const elevenLabsTts: TTSCallable = (text, voiceId) =>
  elevenLabsSynthesizeBytes(text, voiceId);
