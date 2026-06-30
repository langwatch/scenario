// Shared judge criteria for voice scenarios.
//
// WHY THIS EXISTS — counting utterances is not enough. A run can produce N user
// audio turns + M agent replies (the "count utterances" metric) and STILL be
// incoherent: the agent answering a different question, repeating a canned line,
// or talking past the user because it never actually heard the speech. Segment
// counts + ingest 201s prove audio *moved*; they do NOT prove the agents *heard
// each other*. This criterion makes the judge grade that directly.
//
// WHY IT IS NOT THEATER — the judge runs an STT pre-pass (src/voice/judge-stt.ts,
// gpt-4o-transcribe) over the actual audio and keeps the audio part so it can
// hear prosody. So it grades transcripts of what was really spoken, not the TTS
// source text. An agent that mishears produces a reply that will not match the
// user's turn, and this criterion fails the run.

/**
 * MUTUAL-HEARING / COHERENCE criterion. The load-bearing voice criterion: did
 * the agents actually hear and respond to each other?
 */
export const AGENTS_HEARD_EACH_OTHER =
  "Mutual hearing & coherence: every agent turn directly and specifically " +
  "addresses what the user actually said in the immediately preceding turn, " +
  "demonstrating the agent heard and understood the user's speech. The dialogue " +
  "must read as a real two-way conversation that makes sense end to end — NOT a " +
  "non-sequitur, NOT answering a different question, NOT a canned line that " +
  "ignores the user's words, NOT two scripts talking past each other. An agent " +
  "that declines or deflects a request still satisfies this ONLY IF the decline " +
  "is a direct, on-topic response to what the user actually asked.";

/** Default coherence criteria bundle for a voice judge. */
export const VOICE_COHERENCE_CRITERIA: readonly string[] = [
  AGENTS_HEARD_EACH_OTHER,
];
