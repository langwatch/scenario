/**
 * STT subtree barrel + registration site.
 *
 * Side-effect-registers the concrete providers into the `stt-provider`
 * router so `resolveSttProvider("openai/...")` / `"elevenlabs/..."` work,
 * and re-exports the interface, router, and provider classes.
 *
 * Replaces the flat `voice/stt.ts` (one file per provider — EDR §5.3).
 * The PR2 module-global (`setSttProvider`/`getSttProvider`) is gone;
 * provider state is per-run on `ScenarioConfig.voice` (ADR-002).
 */

export {
  type STTProvider,
  type SttProviderFactory,
  resolveSttProvider,
  registerSttProvider,
  listSttProviders,
} from "./stt-provider";

export {
  OpenAISTTProvider,
  OPENAI_TRANSCRIBE_LIMIT_SECONDS,
  type OpenAISTTProviderOptions,
} from "./openai-stt";

export {
  ElevenLabsSTTProvider,
  ELEVENLABS_STT_ENDPOINT,
  type ElevenLabsSTTProviderOptions,
} from "./elevenlabs-stt";

export { pcm16ToWav } from "./wav";

// --- Registration (side effects) ------------------------------------------
import { ElevenLabsSTTProvider } from "./elevenlabs-stt";
import { OpenAISTTProvider } from "./openai-stt";
import { registerSttProvider } from "./stt-provider";

registerSttProvider("openai", (model) =>
  model ? new OpenAISTTProvider({ model }) : new OpenAISTTProvider(),
);
registerSttProvider(
  "elevenlabs",
  () => new ElevenLabsSTTProvider(),
);
