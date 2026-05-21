/**
 * ElevenLabsVoiceAgent — branded composable preset.
 *
 * TypeScript port of the `ElevenLabsVoiceAgent` class in
 * `python/scenario/voice/adapters/composable.py`.
 *
 * Not to be confused with {@link ElevenLabsAgentAdapter} (in `./elevenlabs`)
 * which talks to ElevenLabs' **hosted** ConvAI endpoint. This class is
 * **local**: you compose `ElevenLabsSTTProvider` + any LLM + ElevenLabs
 * TTS yourself, keeping control over prompts, model choice, and tool calls.
 *
 * Default stack:
 *   - STT: {@link ElevenLabsSTTProvider} with the same API key.
 *   - LLM: `openai("gpt-5.4-mini")` — text-only chat completion.
 *   - TTS: `elevenlabs/EXAVITQu4vr4xnSDxMaL` (Sarah — free-tier premade).
 *     Override via the `ELEVENLABS_VOICE_ID` env var or the `voice` arg.
 *
 * Each piece can be overridden independently without changing the others.
 */
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

import {
  COMPOSABLE_VOICE_LLM_MODEL,
  ELEVENLABS_DEFAULT_VOICE_ID,
} from "../voice-models";
import {
  ComposableVoiceAgent,
  ElevenLabsSTTProvider,
  type STTProvider,
  type SynthesizeOptions,
} from "./composable";

/**
 * Provider-specific signatures — `api_key` is required, every other knob is
 * an optional override with an EL-opinionated default.
 */
export interface ElevenLabsVoiceAgentOptions {
  apiKey: string;
  /** Override the default ai-sdk LanguageModel. Defaults to `openai("gpt-5.4-mini")`. */
  llm?: LanguageModel;
  /**
   * TTS voice string in `"elevenlabs/<voiceId>"` form. Defaults to the
   * `ELEVENLABS_VOICE_ID` env var when set, otherwise to
   * `elevenlabs/EXAVITQu4vr4xnSDxMaL` (Sarah).
   */
  voice?: string;
  /** Plug an alternate STT — defaults to {@link ElevenLabsSTTProvider}. */
  stt?: STTProvider;
  /** Override the system prompt. Defaults to {@link ComposableVoiceAgent.DEFAULT_SYSTEM_PROMPT}. */
  systemPrompt?: string;
  /** Test seam — forwarded to the underlying `synthesize` helper. */
  ttsOptions?: SynthesizeOptions;
}

/**
 * Composable voice agent with ElevenLabs-opinionated defaults.
 *
 * @example
 * ```ts
 * // Defaults — all ElevenLabs STT, gpt-5.4-mini, EL TTS
 * const agent = new ElevenLabsVoiceAgent({ apiKey: process.env.ELEVENLABS_API_KEY! });
 *
 * // Override just the LLM
 * import { anthropic } from "@ai-sdk/anthropic";
 * const agent = new ElevenLabsVoiceAgent({ apiKey, llm: anthropic("claude-sonnet-4-6") });
 *
 * // Bring your own STT
 * const agent = new ElevenLabsVoiceAgent({ apiKey, stt: new MyCustomSTT() });
 * ```
 */
export class ElevenLabsVoiceAgent extends ComposableVoiceAgent {
  readonly voice: string;

  constructor(options: ElevenLabsVoiceAgentOptions) {
    const voice = options.voice ?? resolveDefaultVoice();
    const stt = options.stt ?? new ElevenLabsSTTProvider({ apiKey: options.apiKey });
    const llm = options.llm ?? openai(COMPOSABLE_VOICE_LLM_MODEL);
    const ttsOptions: SynthesizeOptions = {
      apiKey: options.apiKey,
      ...options.ttsOptions,
    };

    super({
      stt,
      llm,
      tts: voice,
      systemPrompt: options.systemPrompt,
      ttsOptions,
    });

    this.voice = voice;
  }

  override toString(): string {
    return `ElevenLabsVoiceAgent(apiKey='***', llm=<LanguageModel>, voice='${this.voice}')`;
  }
}

function resolveDefaultVoice(): string {
  const envVoice = process.env.ELEVENLABS_VOICE_ID;
  if (envVoice) return `elevenlabs/${envVoice}`;
  return `elevenlabs/${ELEVENLABS_DEFAULT_VOICE_ID}`;
}
