/**
 * ElevenLabs TTS leaf — the `elevenlabs/<voiceId>` backend (Gap #10).
 *
 * Symmetric with {@link OpenAISTTProvider}/`elevenlabs-stt.ts`: a single home
 * for ElevenLabs synthesis so `voice="elevenlabs/..."` resolves through the
 * TTS registry instead of being buried in `adapters/composable.ts`. The
 * composable agent consumes this leaf for its EL path (de-dup, Gap #5).
 *
 * Wire: `client.textToSpeech.convert(voiceId, { modelId: eleven_v3,
 * outputFormat: "pcm_24000" })` → raw PCM16/24 kHz mono, matching the
 * canonical {@link AudioChunk}. A `voiceStyle` rides on the text as an inline
 * `[angry]`-style marker — see {@link applyVoiceStyle}.
 *
 * Registered under the `elevenlabs` prefix by `tts/index.ts` (side effect).
 */
import { Buffer } from "node:buffer";

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

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
  /**
   * Named delivery style for this utterance, e.g. `"angry"` (#533). Applied as
   * an inline paralinguistic marker on the text — see {@link applyVoiceStyle}
   * for why that, and not `voiceSettings.style`.
   */
  voiceStyle?: string;
}

const defaultClientFactory: ElevenLabsClientFactory = (apiKey) =>
  new ElevenLabsClient({ apiKey });

/**
 * Prefix `text` with the inline `[style]` marker that {@link
 * ELEVENLABS_TTS_MODEL} reads as a delivery instruction.
 *
 * **Design decision (#533).** ElevenLabs has no named-style field: its
 * `voiceSettings.style` is a NUMERIC 0–1 *exaggeration* knob, so a string like
 * `"angry"` has nowhere to go — passing it there is a type error, and mapping
 * it to a number would be inventing a meaning the API never promised. What
 * `eleven_v3` (already the pinned model, for exactly this reason) DOES honour
 * is inline paralinguistic markers — `[angry]`, `[whispering]`, `[laughs]`.
 * Prepending the marker is therefore the mechanism that actually makes a named
 * style audible, so that is what a `voiceStyle` maps to here.
 *
 * Idempotent: text that already opens with the same marker is returned
 * unchanged, so a caller that hand-wrote `[angry] …` is not double-prepended.
 */
function applyVoiceStyle(text: string, voiceStyle?: string): string {
  if (!voiceStyle) return text;
  const marker = `[${voiceStyle}]`;
  if (text.startsWith(marker)) return text;
  return `${marker} ${text}`;
}

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
    text: applyVoiceStyle(text, options.voiceStyle),
    modelId: ELEVENLABS_TTS_MODEL,
    outputFormat: "pcm_24000",
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

  /**
   * `(text, voiceId, options?) => PCM16/24kHz bytes`, bound to this provider's
   * options. A per-call `voiceStyle` wins over a construction-time one.
   */
  readonly synth: TTSCallable = (text, voiceId, options) =>
    elevenLabsSynthesizeBytes(text, voiceId, {
      ...this.options,
      voiceStyle: options?.voiceStyle ?? this.options.voiceStyle,
    });
}

/** Registry callable — uses the env API key (the `elevenlabs/...` router path). */
export const elevenLabsTts: TTSCallable = (text, voiceId, options) =>
  elevenLabsSynthesizeBytes(text, voiceId, { voiceStyle: options?.voiceStyle });
