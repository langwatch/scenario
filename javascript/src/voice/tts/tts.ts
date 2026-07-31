/**
 * Text-to-speech router and cache (the core; provider leaves live alongside).
 *
 * Python parity: `python/scenario/voice/tts.py`. Litellm-style routing — voice
 * strings are `provider/name` (e.g. `openai/nova`, `elevenlabs/rachel`). The
 * TTS cache key is `(sha256(text), voice, voiceStyle)` so raw user-supplied
 * text never reaches the cache payload; audio effects apply AFTER cache hit
 * and are never baked into stored audio.
 *
 * TS leads Python here: `voiceStyle` (issue #533) is a per-call synthesis
 * option threaded from the user simulator down to the provider. Python's
 * `synthesize(text, voice)` still has no style channel — this is NOT parity.
 *
 * Concrete providers (OpenAI, ElevenLabs) are one-file-per-provider leaves that
 * self-register via `tts/index.ts` (mirrors the `stt/` subtree, EDR §5.3). This
 * module owns the interface, the registry router, `synthesize()`, and the LRU
 * cache only — no provider SDK imports.
 */
import { createHash } from "node:crypto";

import { AudioChunk } from "../audio-chunk";

/**
 * Per-call synthesis options that are NOT part of the voice identity.
 *
 * Kept separate from the `provider/name` voice string because the SAME voice
 * can speak in many styles — the style varies per utterance, the voice does
 * not. Optional on {@link TTSCallable} so existing two-argument provider
 * callables stay assignable.
 */
export interface TtsSynthesisOptions {
  /**
   * Named delivery style for this utterance, e.g. `"angry"`, `"whispering"`.
   * Providers map it onto their own style channel (ElevenLabs: an inline
   * `[angry]` marker; OpenAI: the `instructions` parameter) and opt in via
   * {@link TtsProvider.supportsVoiceStyle}. A provider that has not opted in
   * gets the style stripped, and the router warns once.
   */
  voiceStyle?: string;
}

/**
 * A TTS backend: takes (text, voiceName, options?) and returns PCM16/24kHz
 * mono bytes. `options` carries per-call, non-identity knobs such as
 * {@link TtsSynthesisOptions.voiceStyle}.
 */
export type TTSCallable = (
  text: string,
  voiceName: string,
  options?: TtsSynthesisOptions,
) => Promise<Uint8Array>;

/**
 * A TTS provider registration — a litellm-style prefix and the function that
 * synthesizes for the names served by that prefix.
 */
export interface TtsProvider {
  prefix: string;
  synth: TTSCallable;
  /**
   * Whether `synth` honours {@link TtsSynthesisOptions.voiceStyle}. Defaults
   * to `false` — a provider that has not opted in has the style STRIPPED and
   * the router warns once, rather than quietly returning unstyled audio the
   * caller believes is styled.
   */
  supportsVoiceStyle?: boolean;
}

/**
 * Apply post-cache audio shaping. Effects are pure functions over the canonical
 * AudioChunk; they never participate in the cache key.
 */
export type TtsEffectFn = (chunk: AudioChunk) => AudioChunk | Promise<AudioChunk>;

/** Registry entry — the callable plus the capabilities it declared. */
interface RegisteredTtsProvider {
  synth: TTSCallable;
  supportsVoiceStyle: boolean;
}

const PROVIDERS = new Map<string, RegisteredTtsProvider>();

/**
 * In-process LRU cache keyed on (sha256(text), voice, voiceStyle) → PCM16
 * bytes. Bounded to prevent unbounded memory growth — a 5-minute clip is
 * ~14 MB, so 64 entries caps the cache at ~900 MB even for long utterances.
 * (Mirrors the Python tuning.)
 */
const CACHE_MAX_ENTRIES = 64;
const CACHE = new Map<string, Uint8Array>();

/** Clear the in-process TTS cache. Used by tests and long-lived processes. */
export function clearTtsCache(): void {
  CACHE.clear();
}

/**
 * Prefixes already warned about an ignored `voiceStyle`. One warning per
 * provider for the life of the process — a styled multi-turn run would
 * otherwise repeat the same line on every turn.
 */
const VOICE_STYLE_WARNED = new Set<string>();

/**
 * Reset the one-shot "provider ignores voiceStyle" warning ledger.
 *
 * @internal Test-only seam. Deliberately NOT folded into
 * {@link clearTtsCache}: the two have unrelated lifetimes, and a suite that
 * clears the cache between cases must not silently re-arm the warning it is
 * asserting fires exactly once.
 */
export function __resetVoiceStyleWarnings(): void {
  VOICE_STYLE_WARNED.clear();
}

function warnVoiceStyleUnsupportedOnce(
  provider: string,
  voiceStyle: string,
): void {
  if (VOICE_STYLE_WARNED.has(provider)) return;
  VOICE_STYLE_WARNED.add(provider);
  console.warn(
    `[scenario] TTS provider ${JSON.stringify(provider)} does not support ` +
      `voiceStyle — the style ${JSON.stringify(voiceStyle)} is ignored and ` +
      "this turn is synthesized unstyled. Providers declare support with " +
      "registerTtsProvider({ …, supportsVoiceStyle: true }).",
  );
}

/** Register a TTS backend under the given provider prefix. */
export function registerTtsProvider(provider: TtsProvider): void {
  PROVIDERS.set(provider.prefix.toLowerCase(), {
    synth: provider.synth,
    supportsVoiceStyle: provider.supportsVoiceStyle ?? false,
  });
}

/** Test-only: enumerate registered provider prefixes. */
export function listTtsProviders(): string[] {
  return Array.from(PROVIDERS.keys()).sort();
}

function splitVoice(voice: string): { provider: string; name: string } {
  const slash = voice.indexOf("/");
  if (slash < 0) {
    throw new Error(
      `Voice string ${JSON.stringify(voice)} must be in 'provider/name' format, ` +
        "e.g. 'openai/nova'",
    );
  }
  return {
    provider: voice.slice(0, slash).toLowerCase(),
    name: voice.slice(slash + 1),
  };
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function cacheKey(textHash: string, voice: string, voiceStyle?: string): string {
  // Composite key — text hash, voice and voice style are all load-bearing.
  // "voice" is the full provider/name string so two providers can't collide.
  // `voiceStyle` is in the key because it changes the synthesized AUDIO, not
  // just the request: without it, an angry turn and a neutral turn with the
  // same (text, voice) would share one entry, so whichever ran first would
  // silently serve its bytes to the other (issue #533). Effects stay OUT of
  // the key — they are applied after the cache read, never baked in.
  return `${textHash}:${voice}:${voiceStyle ?? ""}`;
}

/** True when `options` carries at least one set value (all fields optional). */
function hasAnyOption(options?: TtsSynthesisOptions): boolean {
  return (
    options !== undefined && Object.values(options).some((v) => v !== undefined)
  );
}

async function synthesizeRaw(
  text: string,
  voice: string,
  options?: TtsSynthesisOptions,
): Promise<Uint8Array> {
  const { provider, name } = splitVoice(voice);
  const registered = PROVIDERS.get(provider);
  if (!registered) {
    throw new Error(
      `Unknown TTS provider ${JSON.stringify(provider)}. Known: ${listTtsProviders().join(", ") || "(none)"}`,
    );
  }

  // A style the backend cannot honour must be loud, not silent — otherwise a
  // scripted `user("…", { voiceStyle: "angry" })` produces cheerful audio and
  // nothing says why. Warn once per provider, then strip ONLY the style so
  // any other per-call option still reaches the backend.
  let effective = options;
  const voiceStyle = options?.voiceStyle;
  if (voiceStyle && !registered.supportsVoiceStyle) {
    warnVoiceStyleUnsupportedOnce(provider, voiceStyle);
    effective = { ...options, voiceStyle: undefined };
  }

  // Providers registered before per-call options existed are two-argument
  // callables. Only widen the call when an option is actually set, so the
  // (dominant) unstyled path keeps its historical arity — a third `undefined`
  // argument is observable to callables that inspect `arguments.length`.
  return hasAnyOption(effective)
    ? registered.synth(text, name, effective)
    : registered.synth(text, name);
}

/**
 * Synthesize `text` into an {@link AudioChunk} using the voice provider.
 *
 * Cache key is `(sha256(text), voice, voiceStyle)` — equivalent determinism to
 * `(text, voice, voiceStyle)` without pinning raw text in the cache payload.
 * Effects pass through `effectFn` AFTER a cache hit and are never part of the
 * key, matching the locked-decision invariant from the Python port.
 *
 * @param options Per-call synthesis knobs (currently
 *   {@link TtsSynthesisOptions.voiceStyle}) forwarded to the provider.
 */
export async function synthesize(
  text: string,
  voice: string,
  effectFn?: TtsEffectFn,
  options?: TtsSynthesisOptions,
): Promise<AudioChunk> {
  const key = cacheKey(hashText(text), voice, options?.voiceStyle);
  let pcm = CACHE.get(key);
  if (pcm !== undefined) {
    // LRU touch — delete + set re-inserts at the tail of insertion order.
    CACHE.delete(key);
    CACHE.set(key, pcm);
  } else {
    pcm = await synthesizeRaw(text, voice, options);
    CACHE.set(key, pcm);
    while (CACHE.size > CACHE_MAX_ENTRIES) {
      const oldest = CACHE.keys().next().value;
      if (oldest === undefined) break;
      CACHE.delete(oldest);
    }
  }
  const chunk = new AudioChunk({ data: pcm, transcript: text });
  if (effectFn) {
    return effectFn(chunk);
  }
  return chunk;
}
