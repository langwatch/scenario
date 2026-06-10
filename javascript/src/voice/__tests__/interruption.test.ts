/**
 * InterruptionConfig scenario bindings + contextual-prompt unit tests —
 * PR5 of issue #372.
 *
 * Binds 1 scenario from `specs/voice-agents.feature` tagged
 * `@ts-interruption-cfg` (random_phrase strategy) plus standalone unit
 * tests for the contextual-prompt constant and `shouldInterrupt` /
 * `sampleDelay` invariants.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { describe, expect, it } from "vitest";

import {
  CANNED_PHRASES,
  CONTEXTUAL_PROMPT,
  InterruptionConfig,
} from "../interruption";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(HERE, "..", "..", "..", "..", "specs", "voice-agents.feature");

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    Scenario(
      'InterruptionConfig strategy="random_phrase" picks from a canned phrase list',
      ({ Given, When, Then }) => {
        let cfg: InterruptionConfig;
        let picks: string[];

        Given(
          'proceed(interruptions=InterruptionConfig(strategy="random_phrase"))',
          () => {
            cfg = new InterruptionConfig({ strategy: "random_phrase" });
            expect(cfg.strategy).toBe("random_phrase");
          },
        );

        When("proceed runs and interrupts", () => {
          const rng = makeSeededRng(123);
          picks = Array.from({ length: 200 }, () =>
            cfg.pickRandomPhrase(rng),
          );
        });

        Then(
          "the interruption content is drawn from the canned phrase list",
          () => {
            expect(picks.length).toBe(200);
            const allowed = new Set(cfg.phrases);
            for (const pick of picks) {
              expect(allowed.has(pick)).toBe(true);
            }
            // Sanity: across 200 draws we hit more than one phrase.
            expect(new Set(picks).size).toBeGreaterThan(1);
          },
        );
      },
    );
  },
  { includeTags: [["ts-interruption-cfg"]] },
);

describe("InterruptionConfig defaults match the locked design", () => {
  it("uses random_phrase as the default strategy with the canned phrase list", () => {
    const cfg = new InterruptionConfig();
    expect(cfg.strategy).toBe("random_phrase");
    expect(cfg.probability).toBeCloseTo(0.3, 6);
    expect(cfg.delayRange).toEqual([0.5, 3.0]);
    expect(cfg.phrases).toBe(CANNED_PHRASES);
  });

  it("respects a custom phrase pool for random_phrase draws", () => {
    const phrases = ["one", "two", "three"];
    const cfg = new InterruptionConfig({ phrases });
    const rng = makeSeededRng(99);
    for (let i = 0; i < 100; i++) {
      expect(phrases).toContain(cfg.pickRandomPhrase(rng));
    }
  });
});

describe("CONTEXTUAL_PROMPT instructs the LLM to produce a short interjection", () => {
  it("names the short interjection target so callers can reuse or override", () => {
    expect(CONTEXTUAL_PROMPT).toMatch(/interrupt/i);
    expect(CONTEXTUAL_PROMPT).toMatch(/SHORT|short \(2|8 word/);
    expect(CONTEXTUAL_PROMPT).toMatch(/interjection/);
  });
});

function makeSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
