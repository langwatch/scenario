/**
 * TTS subtree barrel + registration site.
 *
 * Side-effect-registers the concrete providers into the router so
 * `synthesize("openai/...")` / `synthesize("elevenlabs/...")` work, and
 * re-exports the interface, router, cache, and provider leaves.
 *
 * Replaces the flat `voice/tts.ts` (one file per provider — EDR §5.3). The LRU
 * cache invariant is preserved (key = sha256(text)+voice; effects applied AFTER
 * cache read) — see `./tts`.
 */

export {
  clearTtsCache,
  listTtsProviders,
  registerTtsProvider,
  synthesize,
  type TTSCallable,
  type TtsEffectFn,
  type TtsProvider,
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
import { registerTtsProvider } from "./tts";
import { openaiTts } from "./openai-tts";
import { elevenLabsTts } from "./elevenlabs-tts";

registerTtsProvider({ prefix: "openai", synth: openaiTts });
registerTtsProvider({ prefix: "elevenlabs", synth: elevenLabsTts });
