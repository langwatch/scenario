/**
 * ComposableVoiceAgent — local STT → LLM → TTS voice agent.
 *
 * TypeScript port of `python/scenario/voice/adapters/composable.py`. The
 * branded preset {@link ElevenLabsVoiceAgent} lives in `./elevenlabs` next to
 * the hosted adapter.
 *
 * Each seam is independently swappable: change `stt` without touching `llm` or
 * `tts`. Intermediate transcripts and LLM responses land on instance
 * attributes (`lastUserTranscript`, `lastLlmResponse`) so the scenario harness
 * can assert on them.
 *
 * STT/TTS interfaces (Gap #5 — de-duped):
 *   - {@link STTProvider} is imported from `../stt` (the canonical interface,
 *     not a local copy). {@link ElevenLabsSTTProvider} from the same subtree is
 *     re-exported here for the EL preset + tests.
 *   - TTS uses voice strings `"<provider>/<voiceId>"` routed through the `../tts`
 *     subtree. The ElevenLabs path consumes the `tts/elevenlabs-tts` leaf
 *     (Gap #10) rather than an inline SDK call.
 */
import {
  generateText,
  type LanguageModel,
  type ModelMessage,
} from "ai";

import { AgentRole } from "../../domain/agents";
import { AudioChunk } from "../audio-chunk";
import { AdapterCapabilities } from "../capabilities";
import { VoiceAgentAdapter } from "../adapter";
import {
  ElevenLabsSTTProvider,
  type STTProvider,
} from "../stt";
import {
  synthesize as routeSynthesize,
  elevenLabsSynthesizeBytes,
  type ElevenLabsClientFactory,
} from "../tts";

// Re-export the canonical STT contract + EL provider so existing importers
// (the EL preset, the adapters barrel, tests) keep their import sites.
export { ElevenLabsSTTProvider, type STTProvider };

// --------------------------------------------------------------- TTS synth
/**
 * Options forwarded to {@link synthesize}. The `elevenLabsClientFactory` test
 * seam maps onto the `tts/elevenlabs-tts` leaf's client factory.
 */
export interface SynthesizeOptions {
  /** API key for the resolved provider. Required for `elevenlabs/...`. */
  apiKey?: string;
  /** Test seam — ElevenLabs SDK client factory. */
  elevenLabsClientFactory?: ElevenLabsClientFactory;
}

/**
 * Synthesize `"<provider>/<voiceId>"` → {@link AudioChunk}.
 *
 * ElevenLabs routes through the `tts/elevenlabs-tts` leaf (honoring the
 * `apiKey` + `elevenLabsClientFactory` test seam); every other provider routes
 * through the canonical TTS registry in `../tts`. No inline SDK calls remain
 * here (Gap #5 / Gap #10).
 */
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
  const provider = voice.slice(0, slash).toLowerCase();
  const voiceId = voice.slice(slash + 1);

  if (provider === "elevenlabs") {
    const bytes = await elevenLabsSynthesizeBytes(text, voiceId, {
      apiKey: options.apiKey,
      clientFactory: options.elevenLabsClientFactory,
    });
    return new AudioChunk({ data: bytes });
  }

  // openai/google/cartesia/… — the registry router resolves the backend.
  return routeSynthesize(text, voice);
}

// ------------------------------------------------------------- composable agent
export interface ComposableVoiceAgentOptions {
  stt: STTProvider;
  /** ai-sdk LanguageModel (e.g. `openai("gpt-5.4-mini")`). */
  llm: LanguageModel;
  /** TTS voice in `"<provider>/<voiceId>"` form. */
  tts: string;
  /**
   * Seeded as the first message in conversation history so the LLM has guidance
   * before any user audio arrives. Defaults to
   * {@link ComposableVoiceAgent.DEFAULT_SYSTEM_PROMPT}.
   */
  systemPrompt?: string;
  /** Test seam — TTS options forwarded to {@link synthesize}. */
  ttsOptions?: SynthesizeOptions;
}

/**
 * Locally-executed STT → LLM → TTS voice agent.
 *
 * `sendAudio` transcribes incoming user audio; `receiveAudio` runs the LLM on
 * the running conversation history and synthesizes the response via TTS.
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
   * tail-silence; on this adapter that would kick a second LLM call. Reset by
   * `sendAudio` (new user turn → new LLM call allowed), set by the end of
   * `receiveAudio`.
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

  // NOTE: no `call()` override. The composable agent INHERITS the base
  // `VoiceAgentAdapter.call()` (= `defaultVoiceCall`), exactly like Python's
  // `ComposableVoiceAgent(VoiceAgentAdapter)`, which does not override `call`.
  // `defaultVoiceCall` extracts the incoming user audio → `sendAudio` (STT) →
  // drains `receiveAudio` (LLM + TTS, gated by `turnOutputEmitted`) → records
  // the segments. A prior stub `call()` returning a bare string short-circuited
  // this so the STT/LLM/TTS seams never fired under `scenario.run()` (the
  // branded EL demo caught it: lastUserTranscript stayed null).

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
