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
