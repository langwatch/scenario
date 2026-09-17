/**
 * ElevenLabs STT leaf — {@link ElevenLabsSTTProvider} (Scribe). Same
 * {@link STTProvider} contract as the OpenAI leaf, different backend.
 *
 * Uses the `scribe_v1` model via the `@elevenlabs/elevenlabs-js` SDK's
 * `speechToText.convert`. PCM16/24 kHz audio is wrapped in a minimal WAV
 * container before posting (EL's endpoint expects a file payload, not raw
 * PCM). Only `text` crosses the {@link STTProvider} boundary — no
 * ElevenLabs-specific types leak.
 *
 * This is the single ElevenLabs STT implementation (Gap #5): the divergent
 * copy that used to live in `adapters/composable.ts` is gone; composable and
 * the branded preset import this leaf.
 */
import { AudioChunk } from "../audio-chunk";
import { normalizeElevenLabsBaseUrl } from "../elevenlabs-base-url";
import {
  type ElevenLabsClientLike,
  loadElevenLabsClient,
} from "../elevenlabs-sdk";
import { ELEVENLABS_STT_MODEL } from "../voice-models";
import type { STTProvider } from "./stt-provider";
import { pcm16ToWav } from "./wav";

/** ElevenLabs STT endpoint (documented for reference; the SDK targets it). */
export const ELEVENLABS_STT_ENDPOINT =
  "https://api.elevenlabs.io/v1/speech-to-text";

/** Construction options for {@link ElevenLabsSTTProvider}. */
export interface ElevenLabsSTTProviderOptions {
  /** API key; falls back to `process.env.ELEVENLABS_API_KEY`. */
  apiKey?: string;
  /**
   * Base URL for the ElevenLabs REST API, passed to the SDK client.
   *
   * Explicit only. `ELEVENLABS_BASE_URL` is deliberately not read here: a
   * LangWatch gateway fronts the ConvAI mint route and not
   * `/v1/speech-to-text`, so a variable set for the hosted demos would point
   * transcription at a route that answers 404. See
   * {@link normalizeElevenLabsBaseUrl}.
   */
  baseUrl?: string;
  /** Test seam — override the SDK client constructor. */
  clientFactory?: (apiKey: string) => ElevenLabsClientLike;
}

/**
 * STT implementation backed by the ElevenLabs speech-to-text SDK.
 */
export class ElevenLabsSTTProvider implements STTProvider {
  private readonly apiKey: string;
  private readonly baseUrl?: string;
  private readonly clientFactory?: (apiKey: string) => ElevenLabsClientLike;

  constructor(options: ElevenLabsSTTProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "";
    this.baseUrl = normalizeElevenLabsBaseUrl(options.baseUrl);
    this.clientFactory = options.clientFactory;
  }

  toString(): string {
    return "ElevenLabsSTTProvider(apiKey='***')";
  }

  async transcribe(audio: AudioChunk): Promise<string> {
    // Loaded here rather than at module scope: the SDK is 4,549 modules and
    // only a run that actually transcribes should pay for them.
    const client = this.clientFactory
      ? this.clientFactory(this.apiKey)
      : await loadElevenLabsClient(this.apiKey, this.baseUrl);
    const wav = pcm16ToWav(audio.data);
    // The SDK accepts Blob/File/ReadStream. Node 20+ supplies Blob globally so
    // we don't need a polyfill.
    const blob = new Blob([new Uint8Array(wav)], { type: "audio/wav" });
    const response = await client.speechToText.convert({
      file: blob,
      modelId: ELEVENLABS_STT_MODEL,
    });
    return response.text ?? "";
  }
}
