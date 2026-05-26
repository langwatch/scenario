/**
 * ElevenLabs STT leaf — {@link ElevenLabsSTTProvider} (Scribe). Same
 * {@link STTProvider} contract as the OpenAI leaf, different backend.
 *
 * Uses the `scribe_v1` model via the `elevenlabs` SDK's
 * `speechToText.convert`. PCM16/24 kHz audio is wrapped in a minimal WAV
 * container before posting (EL's endpoint expects a file payload, not raw
 * PCM). Only `text` crosses the {@link STTProvider} boundary — no
 * ElevenLabs-specific types leak.
 *
 * This is the single ElevenLabs STT implementation (Gap #5): the divergent
 * copy that used to live in `adapters/composable.ts` is gone; composable and
 * the branded preset import this leaf.
 */
import { ElevenLabsClient } from "elevenlabs";

import { AudioChunk } from "../audio-chunk";
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
  /** Test seam — override the SDK client constructor. */
  clientFactory?: (apiKey: string) => ElevenLabsClient;
}

/**
 * STT implementation backed by the ElevenLabs speech-to-text SDK.
 */
export class ElevenLabsSTTProvider implements STTProvider {
  private readonly apiKey: string;
  private readonly clientFactory: (apiKey: string) => ElevenLabsClient;

  constructor(options: ElevenLabsSTTProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "";
    this.clientFactory =
      options.clientFactory ?? ((apiKey) => new ElevenLabsClient({ apiKey }));
  }

  toString(): string {
    return "ElevenLabsSTTProvider(apiKey='***')";
  }

  async transcribe(audio: AudioChunk): Promise<string> {
    const client = this.clientFactory(this.apiKey);
    const wav = pcm16ToWav(audio.data);
    // The SDK accepts Blob/File/ReadStream. Node 20+ supplies Blob globally so
    // we don't need a polyfill.
    const blob = new Blob([new Uint8Array(wav)], { type: "audio/wav" });
    const response = await client.speechToText.convert({
      file: blob,
      model_id: ELEVENLABS_STT_MODEL,
    });
    return response.text ?? "";
  }
}
