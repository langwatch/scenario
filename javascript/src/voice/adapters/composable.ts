/**
 * ComposableVoiceAgent — local STT → LLM → TTS voice agent.
 *
 * TypeScript port of `python/scenario/voice/adapters/composable.py`
 * (ComposableVoiceAgent + STTProvider + ElevenLabsSTTProvider). The branded
 * preset {@link ElevenLabsVoiceAgent} lives in `./eleven-labs-voice-agent`
 * to keep the composable surface independent of EL-specific defaults.
 *
 * Each seam is independently swappable: change `stt` without touching `llm`
 * or `tts`. Intermediate transcripts and LLM responses land on instance
 * attributes (`lastUserTranscript`, `lastLlmResponse`) so the scenario
 * harness can assert on them.
 *
 * STT/TTS interfaces:
 *   - {@link STTProvider}: `transcribe(chunk) → text`. Bring your own; the
 *     {@link ElevenLabsSTTProvider} ships as a default. PR2 (#513) will
 *     bring the OpenAI default; we ship EL only because that's what this
 *     PR is wiring.
 *   - TTS: voice strings of the form `"<provider>/<voice>"`. Only the
 *     `elevenlabs/...` provider is wired here — `openai/`, `google/`,
 *     `cartesia/` arrive with PR2.
 */
import { Buffer } from "node:buffer";

import {
  generateText,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { ElevenLabsClient } from "elevenlabs";

import { AgentRole } from "../../domain/agents";
import { AudioChunk } from "../audio-chunk";
import { AdapterCapabilities } from "../capabilities";
import { VoiceAgentAdapter } from "../adapter";
import { ELEVENLABS_STT_MODEL, ELEVENLABS_TTS_MODEL } from "../voice-models";

/**
 * Speech-to-text provider — the only contract that crosses the composable
 * boundary. Implementations transcribe an {@link AudioChunk} to text;
 * provider-specific types must NOT leak through.
 *
 * PR2 (#513) is expected to introduce a global STTProvider interface in
 * `voice/stt.ts`. If/when that lands first, this declaration is the merge
 * surface — both should converge on the same shape.
 */
export interface STTProvider {
  transcribe(audio: AudioChunk): Promise<string>;
}

/**
 * ElevenLabs STT backed by the `elevenlabs` SDK's `speechToText.convert`.
 *
 * The chunk's canonical PCM16/24 kHz bytes are wrapped in a WAV envelope
 * before posting — EL's REST endpoint expects a file payload, not raw PCM.
 */
export class ElevenLabsSTTProvider implements STTProvider {
  private readonly apiKey: string;
  private readonly clientFactory: (apiKey: string) => ElevenLabsClient;

  constructor(options?: {
    apiKey?: string;
    /** Test seam — production code should not pass this. */
    clientFactory?: (apiKey: string) => ElevenLabsClient;
  }) {
    this.apiKey = options?.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "";
    this.clientFactory =
      options?.clientFactory ?? ((apiKey) => new ElevenLabsClient({ apiKey }));
  }

  toString(): string {
    return "ElevenLabsSTTProvider(apiKey='***')";
  }

  async transcribe(audio: AudioChunk): Promise<string> {
    const client = this.clientFactory(this.apiKey);
    const wav = pcm16ToWavBytes(audio.data);
    // The SDK accepts `Blob`/`File`/`ReadStream`. Node 20+ supplies Blob
    // globally so we don't need a polyfill.
    const blob = new Blob([new Uint8Array(wav)], { type: "audio/wav" });
    const response = await client.speechToText.convert({
      file: blob,
      model_id: ELEVENLABS_STT_MODEL,
    });
    return response.text ?? "";
  }
}

// ---------------------------------------------------------- TTS synth (inline)
/**
 * Minimal `synthesize` helper — parses `"<provider>/<voice>"` and routes
 * to the matching backend. Only `elevenlabs/...` is wired here; PR2
 * (#513) supplies the full multi-provider router. We inline so the
 * composable can ship without depending on PR2's merge order.
 */
export interface SynthesizeOptions {
  /** API key for the resolved provider. Required for `elevenlabs/...`. */
  apiKey?: string;
  /** Test seam — ElevenLabs client factory. */
  elevenLabsClientFactory?: (apiKey: string) => ElevenLabsClient;
}

export async function synthesize(
  text: string,
  voice: string,
  options: SynthesizeOptions = {},
): Promise<AudioChunk> {
  const slash = voice.indexOf("/");
  if (slash < 0) {
    throw new Error(
      `synthesize: voice must be '<provider>/<voiceId>', got '${voice}'`,
    );
  }
  const provider = voice.slice(0, slash);
  const voiceId = voice.slice(slash + 1);

  if (provider === "elevenlabs") {
    const apiKey = options.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "";
    const factory =
      options.elevenLabsClientFactory ??
      ((key: string) => new ElevenLabsClient({ apiKey: key }));
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
    return new AudioChunk({ data: new Uint8Array(Buffer.concat(chunks)) });
  }

  throw new Error(
    `synthesize: provider '${provider}' is not wired in PR7. Only ` +
      "'elevenlabs/' is supported here. Full multi-provider routing arrives with PR2 (#513).",
  );
}

// ------------------------------------------------------------- composable agent
export interface ComposableVoiceAgentOptions {
  stt: STTProvider;
  /** ai-sdk LanguageModel (e.g. `openai("gpt-5.4-mini")`). */
  llm: LanguageModel;
  /** TTS voice in `"<provider>/<voiceId>"` form. */
  tts: string;
  /**
   * Seeded as the first message in conversation history so the LLM has
   * guidance before any user audio arrives. Defaults to
   * {@link ComposableVoiceAgent.DEFAULT_SYSTEM_PROMPT}.
   */
  systemPrompt?: string;
  /** Test seam — TTS options forwarded to {@link synthesize}. */
  ttsOptions?: SynthesizeOptions;
}

/**
 * Locally-executed STT → LLM → TTS voice agent.
 *
 * `sendAudio` transcribes incoming user audio; `receiveAudio` runs the LLM
 * on the running conversation history and synthesizes the response via TTS.
 */
export class ComposableVoiceAgent extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;

  readonly capabilities = new AdapterCapabilities({
    streamingTranscripts: true,
    nativeVad: false,
    dtmf: false,
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });

  static readonly DEFAULT_SYSTEM_PROMPT =
    "You are a helpful voice assistant. Respond naturally and conversationally " +
    "as this is an audio conversation — be concise, friendly, and clear.";

  readonly stt: STTProvider;
  readonly llm: LanguageModel;
  readonly tts: string;
  protected readonly ttsOptions: SynthesizeOptions;
  protected readonly history: ModelMessage[];

  lastUserTranscript: string | null = null;
  lastLlmResponse: string | null = null;

  /**
   * Turn-output guard. The default `call()` drains `receiveAudio` until
   * tail-silence; on this adapter that would kick a second LLM call. Reset
   * by `sendAudio` (new user turn → new LLM call allowed), set by the end
   * of `receiveAudio`.
   */
  protected turnOutputEmitted = false;

  constructor(options: ComposableVoiceAgentOptions) {
    super();
    this.stt = options.stt;
    this.llm = options.llm;
    this.tts = options.tts;
    this.ttsOptions = options.ttsOptions ?? {};
    this.history = [
      {
        role: "system",
        content: options.systemPrompt ?? ComposableVoiceAgent.DEFAULT_SYSTEM_PROMPT,
      },
    ];
  }

  toString(): string {
    return `ComposableVoiceAgent(llm=<LanguageModel>, tts='${this.tts}')`;
  }

  async call(): Promise<string> {
    return "ComposableVoiceAgent";
  }

  async connect(): Promise<void> {
    // No external transport.
  }

  async disconnect(): Promise<void> {
    // Nothing to tear down.
  }

  async sendAudio(chunk: AudioChunk): Promise<void> {
    const transcript = await this.stt.transcribe(chunk);
    this.lastUserTranscript = transcript;
    this.history.push({ role: "user", content: transcript });
    this.turnOutputEmitted = false;
  }

  async receiveAudio(timeout: number): Promise<AudioChunk> {
    if (this.turnOutputEmitted) {
      return new AudioChunk({ data: new Uint8Array(0) });
    }

    const work = (async () => {
      const result = await generateText({
        model: this.llm,
        messages: this.history,
      });
      const responseText = result.text ?? "";
      this.lastLlmResponse = responseText;
      this.history.push({ role: "assistant", content: responseText });

      return synthesize(responseText, this.tts, this.ttsOptions);
    })();

    const chunk = await withTimeout(
      work,
      timeout,
      "ComposableVoiceAgent: receiveAudio timed out",
    );
    this.turnOutputEmitted = true;
    return chunk;
  }
}

// -------------------------------------------------------------- private helpers
function withTimeout<T>(
  promise: Promise<T>,
  timeoutSeconds: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => reject(new Error(message)), timeoutSeconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (err) => {
        clearTimeout(handle);
        reject(err);
      },
    );
  });
}

/**
 * Wrap raw PCM16/24 kHz mono bytes in a minimal WAV envelope. PR2 (#513)
 * will introduce the shared `_pcm16ToWavBytes` helper from
 * `python/scenario/voice/messages.py`; this is the inline mirror so PR7
 * doesn't block on merge order.
 */
function pcm16ToWavBytes(pcm: Uint8Array): Uint8Array {
  const sampleRate = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  const out = new Uint8Array(header.length + pcm.length);
  out.set(header, 0);
  out.set(pcm, header.length);
  return out;
}
