/**
 * The a-leg media-stream nonce comes from the OS CSPRNG (scenario#762, AC13).
 *
 * Differentness, length and hex charset — everything the shape assertions in
 * `twilio-stream-auth.test.ts` check — all survive a regression from
 * `crypto.randomBytes` to a `Math.random()`-built string, so none of them is
 * evidence the value is cryptographically random. This file asserts the
 * PROVENANCE instead: that minting actually calls the CSPRNG, for the documented
 * number of bytes. Isolated in its own file because it mocks `node:crypto`.
 *
 * Mirrors `test_nonce_comes_from_the_os_csprng` in
 * `python/tests/voice/test_twilio_stream_auth.py`.
 */

import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { STREAM_NONCE_BYTES, STREAM_NONCE_HEX_LEN, mintStreamNonce } from "../twilio-shared";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

describe("mintStreamNonce", () => {
  it("AC13: draws its bytes from node:crypto's CSPRNG", () => {
    const spy = vi.mocked(randomBytes);
    spy.mockClear();

    const nonce = mintStreamNonce();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(STREAM_NONCE_BYTES);
    expect(nonce).toHaveLength(STREAM_NONCE_HEX_LEN);
  });
});
