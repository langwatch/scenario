/**
 * TTS router `voiceStyle` plumbing (issue #533).
 *
 * Two invariants, both offline against a fake registered provider:
 *   1. `synthesize(..., { voiceStyle })` reaches the provider callable's third
 *      argument — the style is a per-call option, not part of the voice id.
 *   2. The LRU cache key includes the style. Without it, `(text, voice)` alone
 *      would let an angry turn and a neutral turn share one entry, so whichever
 *      ran first would silently serve its audio to the other.
 *
 * Complements `voice/__tests__/tts.test.ts`, which binds the `@ts-tts` spec
 * scenario for the (text, voice) + effects-after-cache invariants.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  clearTtsCache,
  registerTtsProvider,
  synthesize,
  type TtsSynthesisOptions,
} from "../tts";

const PREFIX = "style-test-tts";

describe("synthesize(..., { voiceStyle }) (#533)", () => {
  beforeEach(() => clearTtsCache());

  it("forwards voiceStyle to the registered provider callable", async () => {
    const seen: Array<TtsSynthesisOptions | undefined> = [];
    registerTtsProvider({
      prefix: PREFIX,
      synth: async (_text, _name, options) => {
        seen.push(options);
        return new Uint8Array([1, 2, 3, 4]);
      },
    });

    await synthesize("hello", `${PREFIX}/alice`, undefined, {
      voiceStyle: "angry",
    });

    expect(seen).toEqual([{ voiceStyle: "angry" }]);
  });

  it("keys the cache on voiceStyle so styled and unstyled turns never collide", async () => {
    const styles: Array<string | undefined> = [];
    registerTtsProvider({
      prefix: PREFIX,
      // Distinct payload per style so a cache collision is visible in the
      // returned BYTES, not just in the call count.
      synth: async (_text, _name, options) => {
        styles.push(options?.voiceStyle);
        return options?.voiceStyle === "angry"
          ? new Uint8Array([9, 9, 9, 9])
          : new Uint8Array([1, 2, 3, 4]);
      },
    });

    const angry = await synthesize("same text", `${PREFIX}/alice`, undefined, {
      voiceStyle: "angry",
    });
    const neutral = await synthesize("same text", `${PREFIX}/alice`);

    // Same text + same voice, different style → two provider calls, two payloads.
    expect(styles).toEqual(["angry", undefined]);
    expect(Array.from(angry.data)).toEqual([9, 9, 9, 9]);
    expect(Array.from(neutral.data)).toEqual([1, 2, 3, 4]);

    // Repeating the SAME (text, voice, style) triple is served from cache.
    const angryAgain = await synthesize(
      "same text",
      `${PREFIX}/alice`,
      undefined,
      { voiceStyle: "angry" },
    );
    expect(styles).toHaveLength(2);
    expect(Array.from(angryAgain.data)).toEqual([9, 9, 9, 9]);
  });
});
