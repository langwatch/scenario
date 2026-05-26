/**
 * ElevenLabs STT leaf — {@link ElevenLabsSTTProvider} (Scribe). Same
 * {@link STTProvider} contract as the OpenAI leaf, different backend.
 *
 * Uses the `scribe_v1` model. PCM16/24 kHz audio is wrapped in a minimal
 * WAV container before posting. Only `text` crosses the {@link STTProvider}
 * boundary — no ElevenLabs-specific types leak.
 */
import { AudioChunk } from "../audio-chunk";
import { ELEVENLABS_STT_MODEL } from "../voice-models";
import type { STTProvider } from "./stt-provider";
import { pcm16ToWav } from "./wav";

/** ElevenLabs STT endpoint. */
export const ELEVENLABS_STT_ENDPOINT =
  "https://api.elevenlabs.io/v1/speech-to-text";

/** Construction options for {@link ElevenLabsSTTProvider}. */
export interface ElevenLabsSTTProviderOptions {
  /** API key; falls back to `process.env.ELEVENLABS_API_KEY`. */
  apiKey?: string;
  /** Override fetch (test hook). */
  fetchImpl?: typeof fetch;
}

/**
 * STT implementation backed by the ElevenLabs REST speech-to-text API.
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
    form.append(
      "file",
      new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
      "audio.wav",
    );
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
