/**
 * scenario.configure({ stt }) tests — PR2 of issue #372.
 *
 * Verifies that the `configure({ stt })` entry point round-trips a custom
 * provider through `setSttProvider` / `getSttProvider`. This is acceptance
 * check #4 of the PR.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { configure } from "../configure";
import {
  OpenAISTTProvider,
  getSttProvider,
  setSttProvider,
  type STTProvider,
} from "../../voice/stt";

describe("scenario.configure({ stt }) round-trips a custom STT provider", () => {
  afterEach(() => {
    setSttProvider(new OpenAISTTProvider());
  });

  it("installs the provided STT provider so getSttProvider() returns it", () => {
    const custom: STTProvider = { transcribe: vi.fn().mockResolvedValue("") };
    configure({ stt: custom });
    expect(getSttProvider()).toBe(custom);
  });

  it("accepts null to clear the configured provider — getSttProvider returns null", () => {
    configure({ stt: null });
    expect(getSttProvider()).toBeNull();
  });

  it("leaves the provider untouched when `stt` is omitted", () => {
    const before = getSttProvider();
    configure({});
    expect(getSttProvider()).toBe(before);
  });
});
