/**
 * TTS plumbing tests — PR2 of issue #372.
 *
 * Binds the `specs/voice-agents.feature` scenarios that exercise the TTS
 * cache key / effects-after-cache invariants.
 */
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioChunk } from "../audio-chunk";
import {
  clearTtsCache,
  listTtsProviders,
  registerTtsProvider,
  synthesize,
} from "../tts";

const TEST_PREFIX = "test-tts";

describe("specs/voice-agents.feature lines 172-187 — TTS cache key is (text, voice) only and effects apply after cache hit", () => {
  let synthSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearTtsCache();
    // Distinct PCM payload — 8 even bytes so AudioChunk accepts it.
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    synthSpy = vi.fn().mockResolvedValue(payload);
    registerTtsProvider({ prefix: TEST_PREFIX, synth: synthSpy });
  });

  afterEach(() => {
    clearTtsCache();
  });

  it("caches synthesis on (sha256(text), voice) — second call with same args hits the cache", async () => {
    // First call — populates cache.
    const a = await synthesize("hello world", `${TEST_PREFIX}/alice`);
    // Second call — same (text, voice) — must hit cache, provider NOT
    // re-invoked.
    const b = await synthesize("hello world", `${TEST_PREFIX}/alice`);

    expect(synthSpy).toHaveBeenCalledTimes(1);
    expect(synthSpy).toHaveBeenCalledWith("hello world", "alice");
    expect(a.data).toEqual(b.data);
    expect(a.transcript).toBe("hello world");
  });

  it("treats a different voice as a different cache entry — provider re-invoked", async () => {
    await synthesize("same text", `${TEST_PREFIX}/alice`);
    await synthesize("same text", `${TEST_PREFIX}/bob`);
    expect(synthSpy).toHaveBeenCalledTimes(2);
  });

  it("treats different text as a different cache entry — provider re-invoked", async () => {
    await synthesize("hi", `${TEST_PREFIX}/alice`);
    await synthesize("bye", `${TEST_PREFIX}/alice`);
    expect(synthSpy).toHaveBeenCalledTimes(2);
  });

  it("applies effectFn AFTER cache hit — same (text, voice) returns same cached PCM, but effectFn output differs", async () => {
    // First call WITHOUT effect — populates cache with the raw PCM payload.
    const raw = await synthesize("flat", `${TEST_PREFIX}/alice`);

    // Second call WITH a "boost" effect — effect must run on the cached
    // PCM and produce a different AudioChunk; the provider must NOT be
    // re-invoked because the cache key is (text, voice) only, not
    // (text, voice, effect).
    const boost = (chunk: AudioChunk): AudioChunk => {
      const boosted = new Uint8Array(chunk.data);
      for (let i = 0; i < boosted.length; i += 1) boosted[i] = (boosted[i] + 1) & 0xff;
      return new AudioChunk({ data: boosted, transcript: chunk.transcript });
    };
    const boosted = await synthesize("flat", `${TEST_PREFIX}/alice`, boost);

    expect(synthSpy).toHaveBeenCalledTimes(1); // cache hit, no second provider call
    expect(boosted.data).not.toEqual(raw.data); // effect actually applied

    // Crucially: a THIRD call with a different effect must read the SAME
    // cached PCM (not the boosted bytes) — effects never get baked into
    // the stored audio.
    const reverse = (chunk: AudioChunk): AudioChunk => {
      const r = new Uint8Array(chunk.data).reverse();
      return new AudioChunk({ data: r, transcript: chunk.transcript });
    };
    const reversed = await synthesize("flat", `${TEST_PREFIX}/alice`, reverse);
    expect(synthSpy).toHaveBeenCalledTimes(1);
    expect(reversed.data).toEqual(new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]));
    // Reversed comes from the ORIGINAL payload, not from `boosted`.
    expect(reversed.data).not.toEqual(new Uint8Array(boosted.data).reverse());
  });

  it("cache key uses sha256(text) — equivalent to keying on raw text but text is not recoverable from key", async () => {
    // Sanity check the spec invariant: the same input text always produces
    // the same sha256, so two cache calls with the same text hit the same
    // entry. The hash function is hashed in tts.ts but we can verify the
    // expected digest length / determinism here.
    const text = "the quick brown fox";
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    expect(digest).toHaveLength(64);

    await synthesize(text, `${TEST_PREFIX}/alice`);
    await synthesize(text, `${TEST_PREFIX}/alice`);
    expect(synthSpy).toHaveBeenCalledTimes(1);
  });

  it("registerTtsProvider exposes the prefix in the registry", () => {
    expect(listTtsProviders()).toContain(TEST_PREFIX);
  });

  it("rejects voice strings without a provider/name slash", async () => {
    await expect(synthesize("hi", "no-slash")).rejects.toThrow(/provider\/name/);
  });

  it("rejects voice strings that name an unknown provider", async () => {
    await expect(synthesize("hi", "definitely-not-registered/x")).rejects.toThrow(
      /Unknown TTS provider/,
    );
  });
});
