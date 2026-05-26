/**
 * Text-to-speech router and cache (the core; provider leaves live alongside).
 *
 * Python parity: `python/scenario/voice/tts.py`. Litellm-style routing — voice
 * strings are `provider/name` (e.g. `openai/nova`, `elevenlabs/rachel`). The
 * TTS cache key is `(sha256(text), voice)` so raw user-supplied text never
 * reaches the cache payload; audio effects apply AFTER cache hit and are never
 * baked into stored audio.
 *
 * Concrete providers (OpenAI, ElevenLabs) are one-file-per-provider leaves that
 * self-register via `tts/index.ts` (mirrors the `stt/` subtree, EDR §5.3). This
 * module owns the interface, the registry router, `synthesize()`, and the LRU
 * cache only — no provider SDK imports.
 */
import { createHash } from "node:crypto";

import { AudioChunk } from "../audio-chunk";

/** A TTS backend: takes (text, voiceName) and returns PCM16/24kHz mono bytes. */
export type TTSCallable = (text: string, voiceName: string) => Promise<Uint8Array>;

/**
 * A TTS provider registration — a litellm-style prefix and the function that
 * synthesizes for the names served by that prefix.
 */
export interface TtsProvider {
  prefix: string;
  synth: TTSCallable;
}

/**
 * Apply post-cache audio shaping. Effects are pure functions over the canonical
 * AudioChunk; they never participate in the cache key.
 */
export type TtsEffectFn = (chunk: AudioChunk) => AudioChunk | Promise<AudioChunk>;

const PROVIDERS = new Map<string, TTSCallable>();

/**
 * In-process LRU cache keyed on (sha256(text), voice) → PCM16 bytes. Bounded to
 * prevent unbounded memory growth — a 5-minute clip is ~14 MB, so 64 entries
 * caps the cache at ~900 MB even for long utterances. (Mirrors the Python
 * tuning.)
 */
const CACHE_MAX_ENTRIES = 64;
const CACHE = new Map<string, Uint8Array>();

/** Clear the in-process TTS cache. Used by tests and long-lived processes. */
export function clearTtsCache(): void {
  CACHE.clear();
}

/** Register a TTS backend under the given provider prefix. */
export function registerTtsProvider(provider: TtsProvider): void {
  PROVIDERS.set(provider.prefix.toLowerCase(), provider.synth);
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

function cacheKey(textHash: string, voice: string): string {
  // Composite key — text hash and voice are both load-bearing; "voice" is the
  // full provider/name string so two providers can't collide.
  return `${textHash}:${voice}`;
}

async function synthesizeRaw(text: string, voice: string): Promise<Uint8Array> {
  const { provider, name } = splitVoice(voice);
  const fn = PROVIDERS.get(provider);
  if (!fn) {
    throw new Error(
      `Unknown TTS provider ${JSON.stringify(provider)}. Known: ${listTtsProviders().join(", ") || "(none)"}`,
    );
  }
  return fn(text, name);
}

/**
 * Synthesize `text` into an {@link AudioChunk} using the voice provider.
 *
 * Cache key is `(sha256(text), voice)` — equivalent determinism to
 * `(text, voice)` without pinning raw text in the cache payload. Effects pass
 * through `effectFn` AFTER a cache hit and are never part of the key, matching
 * the locked-decision invariant from the Python port.
 */
export async function synthesize(
  text: string,
  voice: string,
  effectFn?: TtsEffectFn,
): Promise<AudioChunk> {
  const key = cacheKey(hashText(text), voice);
  let pcm = CACHE.get(key);
  if (pcm !== undefined) {
    // LRU touch — delete + set re-inserts at the tail of insertion order.
    CACHE.delete(key);
    CACHE.set(key, pcm);
  } else {
    pcm = await synthesizeRaw(text, voice);
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
