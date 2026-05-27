/**
 * Reference-free audio-property measurements shared by the voice demos.
 *
 * These let a demo assert the AUDIO half of a scenario promise — the part the
 * LLM judge cannot read from a transcript (e.g. "ambient noise was actually
 * mixed onto the user's TTS", not a silent placeholder or a no-op effect).
 * Extracted here so the angry-customer and background-handoff demos share ONE
 * implementation (review H3 / test NIT — was copy-pasted in both).
 */

/**
 * Noise FLOOR of a PCM16 segment: the RMS of its quietest frames (10th
 * percentile of 20ms-frame RMS). Clean TTS has near-silent gaps (floor ~0);
 * mixing ambient noise lifts the floor across the whole segment. A robust,
 * reference-free way to prove ambience was actually mixed onto the audio.
 *
 * `pcm` is mono PCM16 little-endian; the 480-sample frame is 20ms @ 24kHz.
 */
export function noiseFloorRms(pcm: Uint8Array): number {
  const view = new Int16Array(
    pcm.buffer,
    pcm.byteOffset,
    Math.floor(pcm.byteLength / 2),
  );
  const frame = 480; // 20ms @ 24kHz
  const rmsPerFrame: number[] = [];
  for (let i = 0; i + frame <= view.length; i += frame) {
    let sumsq = 0;
    for (let j = 0; j < frame; j++) sumsq += view[i + j]! * view[i + j]!;
    rmsPerFrame.push(Math.sqrt(sumsq / frame));
  }
  if (rmsPerFrame.length === 0) return 0;
  rmsPerFrame.sort((a, b) => a - b);
  // 10th-percentile frame RMS ≈ the quiet-gap noise floor.
  return rmsPerFrame[Math.floor(rmsPerFrame.length * 0.1)]!;
}
