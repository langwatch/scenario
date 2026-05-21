/**
 * Speech-to-text: pluggable {@link STTProvider} interface with an OpenAI
 * default (`gpt-4o-transcribe`).
 *
 * Python parity: `python/scenario/voice/stt.py`. Users who prefer Deepgram,
 * Whisper, local inference, etc. implement {@link STTProvider} and install
 * it via `scenario.configure({ stt: myProvider })`.
 *
 * The OpenAI default chunks audio longer than 25 minutes per request (the
 * API hard limit). Transcription happens per turn, so chunking is rarely
 * triggered in practice.
 *
 * Interface invariant: only `transcribe(audio: AudioChunk): Promise<string>`
 * crosses the {@link STTProvider} boundary — no OpenAI-specific types leak
 * out. (Bound to spec `STT provider interface is minimal and provider-
 * agnostic`.)
 */
import type OpenAI from "openai";

import {
  AudioChunk,
  PCM16_CHANNELS,
  PCM16_SAMPLE_RATE,
  PCM16_SAMPLE_WIDTH_BYTES,
} from "./audio-chunk";
import { OPENAI_STT_MODEL } from "./voice-models";

/**
 * Speech-to-text provider contract. Implementations consume an
 * {@link AudioChunk} (PCM16 / 24 kHz / mono) and return a text transcript.
 */
export interface STTProvider {
  transcribe(audio: AudioChunk): Promise<string>;
}

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

/** ElevenLabs STT endpoint + model. */
export const ELEVENLABS_STT_ENDPOINT =
  "https://api.elevenlabs.io/v1/speech-to-text";
export const ELEVENLABS_STT_MODEL = "scribe_v1";

/** Construction options for {@link ElevenLabsSTTProvider}. */
export interface ElevenLabsSTTProviderOptions {
  /** API key; falls back to `process.env.ELEVENLABS_API_KEY`. */
  apiKey?: string;
  /** Override fetch (test hook). */
  fetchImpl?: typeof fetch;
}

/**
 * STT implementation backed by the ElevenLabs REST speech-to-text API.
 *
 * Uses the `scribe_v1` model. PCM16/24 kHz audio is wrapped in a minimal
 * WAV container before posting. Only `text` crosses the {@link STTProvider}
 * boundary — no ElevenLabs-specific types leak.
 */
export class ElevenLabsSTTProvider implements STTProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ElevenLabsSTTProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(audio: AudioChunk): Promise<string> {
    const wav = pcm16ToWav(audio.data);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    form.append("model_id", ELEVENLABS_STT_MODEL);
    const response = await this.fetchImpl(ELEVENLABS_STT_ENDPOINT, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey },
      body: form,
    });
    if (!response.ok) {
      // Keep the message minimal — response body may contain key fragments
      // or PII in some surfaces; leave detailed text out of the trace.
      throw new Error(
        `ElevenLabs STT HTTP ${response.status} (see provider logs for body)`,
      );
    }
    const data = (await response.json()) as { text?: string };
    return data.text ?? "";
  }
}

/** The global STT provider — defaults to {@link OpenAISTTProvider}. */
let provider: STTProvider | null = new OpenAISTTProvider();

/**
 * Install a custom STT provider. Pass `null` to clear the configured
 * provider — downstream callers (e.g. {@link transcribeSegments}) treat the
 * cleared state as "best-effort STT not available" and skip without error.
 */
export function setSttProvider(p: STTProvider | null): void {
  provider = p;
}

/** Current STT provider, or `null` if none is configured. */
export function getSttProvider(): STTProvider | null {
  return provider;
}

/** Wrap raw PCM16/24 kHz mono bytes in a minimal WAV (RIFF) container. */
export function pcm16ToWav(pcm: Uint8Array): Uint8Array {
  const dataLen = pcm.length;
  const byteRate = PCM16_SAMPLE_RATE * PCM16_CHANNELS * PCM16_SAMPLE_WIDTH_BYTES;
  const blockAlign = PCM16_CHANNELS * PCM16_SAMPLE_WIDTH_BYTES;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, PCM16_CHANNELS, true);
  view.setUint32(24, PCM16_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, PCM16_SAMPLE_WIDTH_BYTES * 8, true);
  writeAscii(36, "data");
  view.setUint32(40, dataLen, true);

  const out = new Uint8Array(44 + dataLen);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}
