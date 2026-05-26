/**
 * Per-run voice configuration — the keystone of the voice state model.
 *
 * Voice provider/config state rides on `ScenarioConfig.voice` (the carrier
 * that reaches `call()` via `AgentInput.scenarioConfig`), NOT a module
 * global. This is ADR-001 (no process-wide mutable state) applied to voice;
 * see ADR-002. An optional `RunOptions.voice` knob may seed `cfg.voice` at
 * the `run()` boundary, but the object the judge's transcription pass and
 * the user-simulator's TTS pass read is always `cfg.voice`.
 *
 * Resolution priority (the carrier that reaches `call()` is `cfg.voice`):
 *   options?.voice?.stt  ??  cfg.voice?.stt  ??  new OpenAISTTProvider()
 *
 * This module is the single place provider selection / default voice /
 * default format / default models resolve. It does NOT read stray env or
 * mutate its inputs. Constructing the default OpenAI provider per-run is a
 * pure default (one object per run), not shared mutable state.
 */

import {
  OpenAISTTProvider,
  resolveSttProvider,
  type STTProvider,
} from "./stt";
import { OPENAI_STT_MODEL } from "./voice-models";

/**
 * In-message / on-the-wire audio format tag. The canonical in-message
 * format is `"pcm16"` (AI-SDK `file` part `audio/pcm16`, EDR §4.2);
 * adapter-edge codecs may speak others. Kept a string union rather than a
 * full `{encoding;sampleRate;channels}` record because nothing in the core
 * consumes the richer shape yet (the {@link AudioChunk} fixes 24 kHz mono).
 */
export type AudioFormat = "pcm16" | "wav" | "mulaw";

/** Default in-message audio format (EDR §4.2 — AI-SDK `file` `audio/pcm16`). */
export const DEFAULT_AUDIO_FORMAT: AudioFormat = "pcm16";

/** Default STT model id (`gpt-4o-transcribe`). */
export const DEFAULT_STT_MODEL = OPENAI_STT_MODEL;

/**
 * Descriptor form of STT config — a `"provider/model"` spec is resolved to
 * a concrete {@link STTProvider} via the router. Use this when you want the
 * default provider for a vendor; pass an {@link STTProvider} instance on
 * {@link VoiceConfig.stt} for a fully custom (BYO) provider.
 */
export interface SttConfig {
  /** litellm-style spec, e.g. `"openai/gpt-4o-transcribe"`. */
  model: string;
  /** ISO language hint, when the provider supports it. */
  language?: string;
  /** Per-run API key override. */
  apiKey?: string;
}

/** TTS config for the user simulator — `"provider/voice"` routing. */
export interface TtsConfig {
  /** litellm-style `"provider/voice"`, e.g. `"openai/nova"`. */
  voice: string;
  /** Output format hint. */
  format?: AudioFormat;
  /** Per-run API key override. */
  apiKey?: string;
}

/**
 * Per-run voice config that rides on `ScenarioConfig.voice`.
 *
 * `stt` accepts either a concrete {@link STTProvider} instance (BYO) or an
 * {@link SttConfig} descriptor (resolved through the provider router). When
 * unset, the resolver constructs the default OpenAI provider per-run.
 */
export interface VoiceConfig {
  /** Custom provider instance, or a descriptor to resolve via the router. */
  stt?: STTProvider | SttConfig;
  /** TTS provider + voice routing for the user simulator. */
  tts?: TtsConfig;
  /** Default in-message audio format (defaults to {@link DEFAULT_AUDIO_FORMAT}). */
  defaultAudioFormat?: AudioFormat;
  /** Stream conversation audio to local speakers during the run (PRD §4.7). */
  audioPlayback?: boolean;
  // Judge knobs (PRD §4.3) — include_audio / include_timeline / include_traces
  // are read by judge-stt.ts (Tier C) off this same object.
  includeAudio?: boolean;
  includeTimeline?: boolean;
  includeTraces?: boolean;
}

/**
 * The resolved, ready-to-use per-run voice config. `stt` is always a
 * concrete provider here (never a descriptor) — consumers read it directly.
 */
export interface ResolvedVoiceConfig {
  stt: STTProvider;
  tts?: TtsConfig;
  audioFormat: AudioFormat;
  audioPlayback: boolean;
  includeAudio: boolean;
  includeTimeline: boolean;
  includeTraces: boolean;
}

function isSttProvider(value: unknown): value is STTProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { transcribe?: unknown }).transcribe === "function"
  );
}

/** Coerce {@link VoiceConfig.stt} (instance | descriptor | undefined) to a provider. */
function resolveStt(stt: VoiceConfig["stt"]): STTProvider | undefined {
  if (stt === undefined) return undefined;
  if (isSttProvider(stt)) return stt;
  // Descriptor form — route by "provider/model" spec.
  return resolveSttProvider(stt.model);
}

/**
 * Resolve the per-run voice config.
 *
 * Two-tier merge with the `run()`-boundary override in front of the
 * scenario-level config: `optionLevel` (from `RunOptions.voice`) wins
 * field-by-field over `scenarioLevel` (from `ScenarioConfig.voice`), then
 * pure defaults fill the rest. The resolved `stt` is a concrete provider —
 * the default OpenAI provider is constructed here per-run when unset.
 *
 * @param optionLevel   `RunOptions.voice` — the per-invocation override (seeds the carrier).
 * @param scenarioLevel `ScenarioConfig.voice` — the carrier that reaches `call()`.
 * @param defaults      Optional default overrides (test hook).
 */
export function resolveVoiceConfig(
  optionLevel?: VoiceConfig,
  scenarioLevel?: VoiceConfig,
  defaults?: Partial<ResolvedVoiceConfig>,
): ResolvedVoiceConfig {
  const stt =
    resolveStt(optionLevel?.stt) ??
    resolveStt(scenarioLevel?.stt) ??
    defaults?.stt ??
    new OpenAISTTProvider();

  const tts = optionLevel?.tts ?? scenarioLevel?.tts ?? defaults?.tts;

  const audioFormat =
    optionLevel?.defaultAudioFormat ??
    scenarioLevel?.defaultAudioFormat ??
    defaults?.audioFormat ??
    DEFAULT_AUDIO_FORMAT;

  const pick = (
    field: "audioPlayback" | "includeAudio" | "includeTimeline" | "includeTraces",
    fallback: boolean,
  ): boolean =>
    optionLevel?.[field] ??
    scenarioLevel?.[field] ??
    defaults?.[field] ??
    fallback;

  return {
    stt,
    tts,
    audioFormat,
    audioPlayback: pick("audioPlayback", false),
    // Judge defaults: always include transcripts/timeline; traces on when configured.
    includeAudio: pick("includeAudio", false),
    includeTimeline: pick("includeTimeline", true),
    includeTraces: pick("includeTraces", true),
  };
}
