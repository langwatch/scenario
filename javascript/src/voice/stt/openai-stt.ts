/**
 * OpenAI STT leaf — {@link OpenAISTTProvider} implements {@link STTProvider}
 * against OpenAI transcription (`gpt-4o-transcribe` by default). Owns the
 * OpenAI-edge `AudioChunk` → WAV upload conversion. No routing, no other
 * vendors, no message/judge knowledge.
 *
 * Python parity: `python/scenario/voice/stt.py`.
 *
 * The OpenAI default chunks audio longer than 25 minutes per request (the
 * API hard limit). Transcription happens per turn, so chunking is rarely
 * triggered in practice.
 */
import type OpenAI from "openai";

import {
  AudioChunk,
  PCM16_SAMPLE_RATE,
  PCM16_SAMPLE_WIDTH_BYTES,
} from "../audio-chunk";
import { OPENAI_STT_MODEL } from "../voice-models";
import type { STTProvider } from "./stt-provider";
import { pcm16ToWav } from "./wav";

/**
 * OpenAI's per-request audio length limit for transcription, in seconds.
 * `gpt-4o-transcribe` caps at 25 minutes; longer audio must be chunked.
 */
export const OPENAI_TRANSCRIBE_LIMIT_SECONDS = 25 * 60;

/** Construction options for {@link OpenAISTTProvider}. */
export interface OpenAISTTProviderOptions {
  /** Model id; defaults to {@link OPENAI_STT_MODEL} = `gpt-4o-transcribe`. */
  model?: string;
  /** Inject a pre-built OpenAI client; default is `new OpenAI()` lazily. */
  openaiClient?: OpenAI;
  /** Override the chunking threshold (test hook). */
  transcribeLimitSeconds?: number;
}

/**
 * Default STT implementation using OpenAI's `gpt-4o-transcribe` model.
 *
 * Chunks audio exceeding the per-request limit; chunks are transcribed
 * independently and concatenated with single spaces.
 */
export class OpenAISTTProvider implements STTProvider {
  readonly model: string;
  readonly transcribeLimitSeconds: number;
  private clientOverride?: OpenAI;

  constructor(options: OpenAISTTProviderOptions = {}) {
    this.model = options.model ?? OPENAI_STT_MODEL;
    this.transcribeLimitSeconds =
      options.transcribeLimitSeconds ?? OPENAI_TRANSCRIBE_LIMIT_SECONDS;
    this.clientOverride = options.openaiClient;
  }

  async transcribe(audio: AudioChunk): Promise<string> {
    if (audio.durationSeconds <= this.transcribeLimitSeconds) {
      return this.transcribeSingle(audio);
    }
    const samplesPerChunk = Math.floor(
      this.transcribeLimitSeconds * PCM16_SAMPLE_RATE,
    );
    const bytesPerChunk = samplesPerChunk * PCM16_SAMPLE_WIDTH_BYTES;
    const parts: string[] = [];
    for (let i = 0; i < audio.data.length; i += bytesPerChunk) {
      const end = Math.min(i + bytesPerChunk, audio.data.length);
      const sub = new AudioChunk({ data: audio.data.subarray(i, end) });
      const text = await this.transcribeSingle(sub);
      if (text) parts.push(text);
    }
    return parts.join(" ");
  }

  private async getClient(): Promise<OpenAI> {
    if (this.clientOverride) return this.clientOverride;
    const { default: OpenAI } = await import("openai");
    return new OpenAI();
  }

  private async transcribeSingle(audio: AudioChunk): Promise<string> {
    const wav = pcm16ToWav(audio.data);
    const client = await this.getClient();
    const file = new File([new Uint8Array(wav)], "audio.wav", {
      type: "audio/wav",
    });
    const response = await client.audio.transcriptions.create({
      model: this.model,
      file,
    });
    return (response as { text?: string }).text ?? "";
  }
}
