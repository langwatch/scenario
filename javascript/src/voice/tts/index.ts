/**
 * TTS subtree barrel + registration site.
 *
 * Side-effect-registers the concrete providers into the router so
 * `synthesize("openai/...")` / `synthesize("elevenlabs/...")` work, and
 * re-exports the interface, router, cache, and provider leaves.
 *
 * Replaces the flat `voice/tts.ts` (one file per provider — EDR §5.3). The LRU
 * cache invariant is preserved (key = sha256(text)+voice+voiceStyle; effects
 * applied AFTER cache read) — see `./tts`.
 */

export {
  clearTtsCache,
  listTtsProviders,
  registerTtsProvider,
  synthesize,
  __resetVoiceStyleWarnings,
  type TTSCallable,
  type TtsEffectFn,
  type TtsProvider,
  type TtsSynthesisOptions,
} from "./tts";

export { openaiTts } from "./openai-tts";

export {
  ElevenLabsTtsProvider,
  elevenLabsTts,
  elevenLabsSynthesizeBytes,
  type ElevenLabsClientFactory,
  type ElevenLabsTtsOptions,
} from "./elevenlabs-tts";

// --- Registration (side effects) ------------------------------------------
import { elevenLabsTts } from "./elevenlabs-tts";
import { openaiTts } from "./openai-tts";
import { registerTtsProvider } from "./tts";

// Both leaves honour `voiceStyle` (#533): OpenAI via the `instructions`
// parameter, ElevenLabs via an inline `[angry]` marker on `eleven_v3`.
registerTtsProvider({
  prefix: "openai",
  synth: openaiTts,
  supportsVoiceStyle: true,
});
registerTtsProvider({
  prefix: "elevenlabs",
  synth: elevenLabsTts,
  supportsVoiceStyle: true,
});
