/**
 * OpenAI TTS leaf — the default `openai/<voice>` backend.
 *
 * Uses {@link OPENAI_TTS_MODEL} and asks for `pcm` response format —
 * documented as raw PCM16 @ 24 kHz mono, matching our canonical
 * {@link AudioChunk}. Trims a trailing odd byte so a single transport glitch
 * can't poison the cache via the PCM16 byte-pair invariant.
 *
 * Registered under the `openai` prefix by `tts/index.ts` (side effect).
 *
 * **Model overriding:** this callable has no model parameter. The TTS model
 * ({@link OPENAI_TTS_MODEL}) is a module-level constant — the deliberate
 * design choice is that callers swap the whole callable (i.e. supply a
 * different {@link TTSCallable}) rather than parameterising this one.
 * See {@link OPENAI_TTS_MODEL} for why it is the current-gen default.
 *
 * That rule has exactly one documented exception: `voiceStyle` (#533). It is
 * per-utterance, not per-backend — the same voice on the same model speaks an
 * angry turn and a calm one — so swapping the callable would be the wrong
 * granularity. `gpt-4o-mini-tts` exposes an `instructions` parameter for
 * precisely this, so the style maps onto it.
 */
import { OPENAI_TTS_MODEL } from "../voice-models";
import type { TTSCallable } from "./tts";

/**
 * OpenAI TTS callable — `(text, voiceName, options?) => PCM16/24kHz bytes`.
 *
 * `options.voiceStyle` becomes an `instructions` prompt. The key is omitted
 * entirely when no style is set, so the unstyled request is byte-for-byte the
 * one this callable always sent.
 */
export const openaiTts: TTSCallable = async (text, voiceName, options) => {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI();
  const voiceStyle = options?.voiceStyle;
  const response = await client.audio.speech.create({
    model: OPENAI_TTS_MODEL,
    voice: voiceName,
    input: text,
    response_format: "pcm",
    ...(voiceStyle
      ? { instructions: `Speak in a ${voiceStyle} tone.` }
      : {}),
  });
  const arrayBuffer = await response.arrayBuffer();
  let bytes = new Uint8Array(arrayBuffer);
  if (bytes.length % 2 === 1) {
    bytes = bytes.subarray(0, bytes.length - 1);
  }
  return bytes;
};
