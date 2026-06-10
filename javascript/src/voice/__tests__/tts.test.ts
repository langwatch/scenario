/**
 * TTS plumbing tests (issue #372 voice port).
 *
 * Binds the `specs/voice-agents.feature` scenario tagged `@ts-tts` that
 * exercises the TTS cache key / effects-after-cache invariants.
 *
 * Loaded via @amiceli/vitest-cucumber which reads the feature file and fails
 * the suite if any bound scenario is missing a step binding.
 */
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";

import { AudioChunk } from "../audio-chunk";
import {
  clearTtsCache,
  listTtsProviders,
  registerTtsProvider,
  synthesize,
  type TTSCallable,
} from "../tts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(HERE, "..", "..", "..", "..", "specs", "voice-agents.feature");

const TEST_PREFIX = "test-tts";

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    // -----------------------------------------------------------------------
    // Scenario: TTS cache key is (text, voice) only and effects apply after cache hit
    // -----------------------------------------------------------------------
    Scenario(
      "TTS cache key is (text, voice) only and effects apply after cache hit",
      ({ Given, When, Then, And }) => {
        let synthSpy: ReturnType<typeof vi.fn>;

        Given("the same text and voice are used twice with different audio_effects", () => {
          clearTtsCache();
          // Distinct PCM payload — 8 even bytes so AudioChunk accepts it.
          const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
          synthSpy = vi.fn().mockResolvedValue(payload);
          registerTtsProvider({ prefix: TEST_PREFIX, synth: synthSpy as unknown as TTSCallable });

          // Also verify the registry itself is populated.
          expect(listTtsProviders()).toContain(TEST_PREFIX);
        });

        When("TTS is invoked", async () => {
          // First call — populates cache.
          await synthesize("hello world", `${TEST_PREFIX}/alice`);
          // Second call — same (text, voice) — must hit cache.
          await synthesize("hello world", `${TEST_PREFIX}/alice`);
        });

        Then("the TTS synthesis is cached on (text, voice) and only called once", async () => {
          // Provider was invoked exactly once for the two identical calls above.
          expect(synthSpy).toHaveBeenCalledTimes(1);
          expect(synthSpy).toHaveBeenCalledWith("hello world", "alice");

          // Transcript is preserved from the synthesize call.
          const result = await synthesize("hello world", `${TEST_PREFIX}/alice`);
          expect(result.transcript).toBe("hello world");
          // Still only 1 provider call total (cache hit again).
          expect(synthSpy).toHaveBeenCalledTimes(1);

          // Different voice → different cache entry → provider re-invoked.
          clearTtsCache();
          synthSpy.mockClear();
          await synthesize("same text", `${TEST_PREFIX}/alice`);
          await synthesize("same text", `${TEST_PREFIX}/bob`);
          expect(synthSpy).toHaveBeenCalledTimes(2);

          // Different text → different cache entry → provider re-invoked.
          clearTtsCache();
          synthSpy.mockClear();
          await synthesize("hi", `${TEST_PREFIX}/alice`);
          await synthesize("bye", `${TEST_PREFIX}/alice`);
          expect(synthSpy).toHaveBeenCalledTimes(2);

          // Cache key uses sha256(text) — deterministic for identical text.
          const text = "the quick brown fox";
          const digest = createHash("sha256").update(text, "utf8").digest("hex");
          expect(digest).toHaveLength(64);
          clearTtsCache();
          synthSpy.mockClear();
          await synthesize(text, `${TEST_PREFIX}/alice`);
          await synthesize(text, `${TEST_PREFIX}/alice`);
          expect(synthSpy).toHaveBeenCalledTimes(1);
        });

        And(
          "effects are applied to the cached audio after retrieval, never baked in",
          async () => {
            // Reset cache so we start clean for the effects sub-test.
            clearTtsCache();
            synthSpy.mockClear();

            // First call WITHOUT effect — populates cache with the raw PCM.
            const raw = await synthesize("flat", `${TEST_PREFIX}/alice`);

            // Second call WITH a "boost" effect — effect runs on cached PCM;
            // provider must NOT be re-invoked.
            const boost = (chunk: AudioChunk): AudioChunk => {
              const boosted = new Uint8Array(chunk.data);
              for (let i = 0; i < boosted.length; i += 1) boosted[i] = (boosted[i] + 1) & 0xff;
              return new AudioChunk({ data: boosted, transcript: chunk.transcript });
            };
            const boosted = await synthesize("flat", `${TEST_PREFIX}/alice`, boost);

            expect(synthSpy).toHaveBeenCalledTimes(1); // cache hit, no second provider call
            expect(boosted.data).not.toEqual(raw.data); // effect actually applied

            // Third call with a different effect reads the SAME cached PCM
            // (not the boosted bytes) — effects never get baked into stored audio.
            const reverse = (chunk: AudioChunk): AudioChunk => {
              const r = new Uint8Array(chunk.data).reverse();
              return new AudioChunk({ data: r, transcript: chunk.transcript });
            };
            const reversed = await synthesize("flat", `${TEST_PREFIX}/alice`, reverse);
            expect(synthSpy).toHaveBeenCalledTimes(1);
            expect(reversed.data).toEqual(new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]));
            // Reversed comes from the ORIGINAL payload, not from `boosted`.
            expect(reversed.data).not.toEqual(new Uint8Array(boosted.data).reverse());

            // Guard: voice strings without a provider/name slash are rejected.
            await expect(synthesize("hi", "no-slash")).rejects.toThrow(/provider\/name/);

            // Guard: unknown provider prefix is rejected.
            await expect(synthesize("hi", "definitely-not-registered/x")).rejects.toThrow(
              /Unknown TTS provider/,
            );

            // Clean up.
            clearTtsCache();
          },
        );
      },
    );
  },
  { includeTags: ["ts-tts"] },
);
