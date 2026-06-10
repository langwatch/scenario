/**
 * STT provider contract + a `"provider/model"` router.
 *
 * `transcribe.ts` and the per-run config resolver depend on the
 * {@link STTProvider} interface, not on any concrete vendor class (DIP).
 * Concrete providers (OpenAI, ElevenLabs) live in sibling leaf files and
 * register themselves via {@link registerSttProvider} (wired in
 * `stt/index.ts`). No transcription, no clients, no provider-count
 * knowledge lives here.
 *
 * Replaces the PR2 module-global (`let provider = new OpenAISTTProvider()`
 * + `setSttProvider`/`getSttProvider`) — provider state is now per-run on
 * `ScenarioConfig.voice` (see `voice/config.ts`, ADR-002).
 *
 * Interface invariant: only `transcribe(audio: AudioChunk): Promise<string>`
 * crosses the {@link STTProvider} boundary — no vendor-specific types leak.
 * (Bound to spec `STT provider interface is minimal and provider-agnostic`.)
 */

import type { AudioChunk } from "../audio-chunk";

/**
 * Speech-to-text provider contract. Implementations consume an
 * {@link AudioChunk} (PCM16 / 24 kHz / mono) and return a text transcript.
 *
 * Deliberately tiny — a single async method — so a plain object literal
 * satisfies it without importing any provider SDK.
 */
export interface STTProvider {
  transcribe(audio: AudioChunk): Promise<string>;
}

/**
 * A factory that builds a provider for a given litellm-style model spec
 * (e.g. `"openai/gpt-4o-transcribe"`, `"elevenlabs/scribe_v1"`). The
 * `provider` segment selects the factory; the remainder is the model id.
 */
export type SttProviderFactory = (model: string) => STTProvider;

/** provider-segment → factory. Populated by `stt/index.ts` side effects. */
const registry = new Map<string, SttProviderFactory>();

/**
 * Register a factory for a provider segment (e.g. `"openai"`). Called once
 * per concrete provider at module load (from `stt/index.ts`). Idempotent —
 * re-registration overwrites, so a test can swap a factory deterministically.
 */
export function registerSttProvider(
  provider: string,
  factory: SttProviderFactory,
): void {
  registry.set(provider.toLowerCase(), factory);
}

/** The provider segments that currently have a registered factory. */
export function listSttProviders(): string[] {
  return [...registry.keys()];
}

/**
 * Resolve a `"provider/model"` (or bare `"provider"`) spec to a concrete
 * {@link STTProvider}. Throws if the provider segment is unregistered.
 *
 * Examples:
 *   `resolveSttProvider("openai/gpt-4o-transcribe")`
 *   `resolveSttProvider("elevenlabs")`  // default model for the provider
 */
export function resolveSttProvider(spec: string): STTProvider {
  const slash = spec.indexOf("/");
  const provider = (slash === -1 ? spec : spec.slice(0, slash)).toLowerCase();
  const model = slash === -1 ? "" : spec.slice(slash + 1);
  const factory = registry.get(provider);
  if (!factory) {
    throw new Error(
      `Unknown STT provider "${provider}" (from "${spec}"). ` +
        `Registered: ${listSttProviders().join(", ") || "(none)"}. ` +
        "Register one with registerSttProvider() or pass an STTProvider " +
        "instance directly via run({ voice: { stt } }).",
    );
  }
  return factory(model);
}
