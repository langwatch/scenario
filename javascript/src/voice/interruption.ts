/**
 * Interruption configuration for `proceed({ interruptions })`.
 *
 * Source §4.4 L478-492. Two strategies:
 * - `"contextual"`: an LLM generates a short interruption phrase from the
 *   running conversation context.
 * - `"random_phrase"`: draw from a canned phrase list.
 *
 * Python parity: `python/scenario/voice/interruption.py`.
 *
 * The proposal does not supply the contextual LLM prompt — implementer-level
 * decision. We expose a short system prompt focused on realistic user
 * interjections so downstream callers can reuse it as-is or override it.
 */

export type InterruptionStrategy = "contextual" | "random_phrase";

/**
 * Short, realistic mid-turn interruptions. Used as-is for
 * `strategy: "random_phrase"` and as few-shot examples for
 * `strategy: "contextual"`.
 */
export const CANNED_PHRASES: readonly string[] = Object.freeze([
  "Wait, that's not right",
  "No no, let me explain again",
  "Hold on a second",
  "Actually scratch that",
  "Sorry to cut you off",
  "Wait I forgot to mention",
  "Hmm, let me correct you",
]);

/**
 * Default system prompt used when `strategy: "contextual"` asks an LLM to
 * generate a realistic interjection from the running conversation context.
 */
export const CONTEXTUAL_PROMPT =
  "You are simulating a user interrupting an AI agent mid-sentence. " +
  "Produce a SHORT (2–8 word) interjection that would realistically " +
  "cut the agent off. Do not answer their question. Do not greet them. " +
  "Just the interjection — no quotes, no punctuation besides a comma or period.";

export interface InterruptionConfigInit {
  /** Probability in [0, 1] that any given turn gets interrupted. Default 0.3. */
  probability?: number;
  /** Inclusive low/high seconds to wait before injecting the interruption. */
  delayRange?: readonly [number, number];
  /** `"contextual"` uses an LLM; `"random_phrase"` picks from `phrases`. */
  strategy?: InterruptionStrategy;
  /** Phrase pool used by `"random_phrase"` (and as few-shots for contextual). */
  phrases?: readonly string[];
}

/**
 * Configuration for random interruptions during `proceed({ interruptions })`.
 *
 * Defaults match the Python source. `pickRandomPhrase`/`sampleDelay`/
 * `shouldInterrupt` accept an optional `rng` so callers can pass a seeded
 * PRNG for deterministic tests; otherwise `Math.random` is used.
 */
export class InterruptionConfig {
  readonly probability: number;
  readonly delayRange: readonly [number, number];
  readonly strategy: InterruptionStrategy;
  readonly phrases: readonly string[];

  constructor(init: InterruptionConfigInit = {}) {
    this.probability = init.probability ?? 0.3;
    this.delayRange = init.delayRange ?? [0.5, 3.0];
    this.strategy = init.strategy ?? "random_phrase";
    this.phrases = init.phrases ?? CANNED_PHRASES;
  }

  shouldInterrupt(rng: () => number = Math.random): boolean {
    return rng() < this.probability;
  }

  sampleDelay(rng: () => number = Math.random): number {
    const [lo, hi] = this.delayRange;
    return lo + rng() * (hi - lo);
  }

  pickRandomPhrase(rng: () => number = Math.random): string {
    if (this.phrases.length === 0) return "";
    const idx = Math.min(
      this.phrases.length - 1,
      Math.floor(rng() * this.phrases.length),
    );
    return this.phrases[idx];
  }
}
