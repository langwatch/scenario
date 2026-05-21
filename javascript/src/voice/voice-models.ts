/**
 * Default model identifiers for voice paths.
 *
 * Single source of truth so demos, adapters, and any stub bot don't drift.
 * Anything outside this module that needs a model name should import from
 * here.
 *
 * Mirror of `python/scenario/config/voice_models.py`. When OpenAI / Google /
 * ElevenLabs ship a new generation, update this file and re-test once.
 * Avoid sprinkling magic strings.
 */

/** OpenAI Realtime — bidirectional streaming audio API. */
export const OPENAI_REALTIME_MODEL = "gpt-realtime-mini";

/** OpenAI STT — speech-to-text default for the judge / transcript path. */
export const OPENAI_STT_MODEL = "gpt-4o-transcribe";

/** OpenAI TTS — text-to-speech endpoint default. */
export const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";

/** Gemini Live — bidirectional audio (Google's realtime model). */
export const GEMINI_LIVE_MODEL = "gemini-2.5-flash-native-audio-latest";

/**
 * Composable voice agent LLM — text-only, drives the brain of the
 * {@link ComposableVoiceAgent} and {@link ElevenLabsVoiceAgent} stacks
 * (STT → LLM → TTS). Python parity: `COMPOSABLE_VOICE_LLM_MODEL` in
 * `python/scenario/config/voice_models.py`. The Python identifier is the
 * litellm-style string `"openai/gpt-5.4-mini"`; the TS branded preset
 * resolves this to `openai("gpt-5.4-mini")` via the `@ai-sdk/openai`
 * factory.
 */
export const COMPOSABLE_VOICE_LLM_MODEL = "gpt-5.4-mini";

/**
 * Default ElevenLabs TTS model. `eleven_v3` is the only model that honors
 * inline paralinguistic markers like `[shouting]`, `[laughs]`. The SDK's
 * default (`eleven_multilingual_v2`) reads them as text — see Python's
 * `tts.py:107` for the angry-customer regression that drove the hardcode.
 */
export const ELEVENLABS_TTS_MODEL = "eleven_v3";

/** ElevenLabs STT model — Python parity: `stt.py:84`. */
export const ELEVENLABS_STT_MODEL = "scribe_v1";

/**
 * Sarah — premade EL voice, free-tier accessible as of 2026-05. Other
 * premade voices (e.g. Rachel `21m00Tcm4TlvDq8ikWAM`) returned 402
 * paid_plan_required from the EL TTS API. Override via `ELEVENLABS_VOICE_ID`
 * env or the `voice` constructor argument.
 */
export const ELEVENLABS_DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
