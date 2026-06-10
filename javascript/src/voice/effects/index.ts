/**
 * Audio effects pipeline for the voice user simulator (§4.5).
 *
 * Per the TTS cache key locked decision: effects are applied AFTER the TTS
 * cache hit and are never baked into the cached audio.
 *
 * Each effect is an `EffectFn` — `(audio: Uint8Array) => Uint8Array` — that
 * takes PCM16 @ 24kHz mono and returns PCM16 @ 24kHz mono.  Effects are
 * trivially composable.
 *
 * Accents are handled via TTS voice selection (`voice="elevenlabs/raj_indian_english"`),
 * not via post-processing. There is no `accent` effect — by design (§4.5 L536-544).
 *
 * TS equivalent of `python/scenario/voice/effects/__init__.py`.
 */

export { custom } from "./custom";
export { backgroundNoise, multipleVoices } from "./noise";
// Re-export static_ as `static` to match Python public API name (static is a reserved keyword).
export { static_ as static } from "./noise";
export { highVolume, lowVolume, speakingFast, speakingSlow } from "./prosody";
export { breakingUp, echo, lowQuality, packetLoss, phoneQuality, robotic } from "./quality";
export type { EffectFn } from "./common";
