// Shared LLM-judge criteria for the audio example scenarios.
//
// WHY THIS EXISTS — three sibling examples (JS audio-to-audio, JS audio-to-text,
// Python audio-to-text) judge the same thing and were aligned by #655/#612 by
// copy-paste. Copies drift: #680 found two latent gaps that had to be fixed in
// three places at once. The two JS siblings now import these constants, and
// `audio-judge-criteria-parity.test.ts` asserts the Python sibling still carries
// byte-identical strings — so a future edit to one copy cannot silently pass CI.
//
// WHY THE WORDING IS DEFENSIVE (#680):
//   - Criterion 1 used to accept "acknowledges what it heard", which let a
//     broken pipeline pass: empty audio in, "I received your audio" out.
//   - Criterion 3 is satisfied by a polite deflection ("sorry, I can't process
//     audio files") because that too names the non-text format, so criterion 2
//     has to exclude deflection explicitly rather than leaning on "refusal".

/**
 * The three criteria the audio examples judge against, in order.
 *
 * Keep in sync with `python/examples/helpers/audio_judge_criteria.py`. The
 * parity test enforces it.
 *
 * `as const` is load-bearing, not decoration: it makes the array readonly, so a
 * sibling cannot push a drifted criterion onto the shared copy. The Python copy
 * is a tuple for the same reason.
 */
export const AUDIO_JUDGE_CRITERIA = [
  "The agent's response demonstrates it processed the SPECIFIC content of the audio — it addresses or attempts to answer the actual question that was asked in the audio. A generic acknowledgement that audio was received (e.g. 'I got your audio file', 'I heard your message') does NOT satisfy this criterion on its own",
  "The agent provides a coherent, on-topic response — NOT an error message, NOT a refusal, NOT a polite deflection or claim that it cannot process audio / non-text input (e.g. 'I'm sorry, I can't listen to audio files'), and NOT an unrelated reply",
  "The agent's response indicates it received input in a non-text format, or that the question came via audio rather than text (exact phrasing does not matter)",
] as const;
