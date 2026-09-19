/**
 * Router warning for providers that cannot honour `voiceStyle` (issue #533).
 *
 * A style the backend drops must be LOUD, not silent: otherwise a scripted
 * `user("…", { voiceStyle: "angry" })` yields cheerful audio and nothing says
 * why. The router warns once per provider — a styled multi-turn run must not
 * repeat the line on every turn — and strips the style so the backend
 * synthesizes unstyled rather than receiving an option it ignores.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  __resetVoiceStyleWarnings,
  clearTtsCache,
  registerTtsProvider,
  synthesize,
} from "../tts";

const UNSUPPORTED = "style-unaware-tts";
const OTHER_UNSUPPORTED = "style-unaware-tts-two";
const SUPPORTED = "style-aware-tts";

/** Register a provider that records the style it was handed, if any. */
function registerRecorder(prefix: string, supportsVoiceStyle: boolean) {
  const styles: Array<string | undefined> = [];
  registerTtsProvider({
    prefix,
    supportsVoiceStyle,
    synth: async (_text, _name, options) => {
      styles.push(options?.voiceStyle);
      return new Uint8Array([1, 2, 3, 4]);
    },
  });
  return styles;
}

describe("synthesize() voiceStyle on a provider that does not support it (#533)", () => {
  beforeEach(() => {
    clearTtsCache();
    __resetVoiceStyleWarnings();
  });

  it("warns exactly once per provider, names it and the style, and synthesizes unstyled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const styles = registerRecorder(UNSUPPORTED, false);

    // DIFFERENT text on the second call so it misses the cache and genuinely
    // reaches the router again — otherwise a cache hit, not the one-shot
    // ledger, would be what suppresses the second warning.
    await synthesize("first line", `${UNSUPPORTED}/alice`, undefined, {
      voiceStyle: "angry",
    });
    await synthesize("second line", `${UNSUPPORTED}/alice`, undefined, {
      voiceStyle: "angry",
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain(UNSUPPORTED);
    expect(message).toContain("angry");
    // Both turns synthesized unstyled — the style is stripped, not forwarded.
    expect(styles).toEqual([undefined, undefined]);

    warn.mockRestore();
  });

  it("warns per provider, not once globally", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerRecorder(UNSUPPORTED, false);
    registerRecorder(OTHER_UNSUPPORTED, false);

    await synthesize("a line", `${UNSUPPORTED}/alice`, undefined, {
      voiceStyle: "angry",
    });
    await synthesize("a line", `${OTHER_UNSUPPORTED}/alice`, undefined, {
      voiceStyle: "angry",
    });

    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]?.[0])).toContain(OTHER_UNSUPPORTED);

    warn.mockRestore();
  });

  it("never warns for a provider that declares supportsVoiceStyle", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const styles = registerRecorder(SUPPORTED, true);

    await synthesize("a line", `${SUPPORTED}/alice`, undefined, {
      voiceStyle: "angry",
    });

    expect(warn).not.toHaveBeenCalled();
    expect(styles).toEqual(["angry"]);

    warn.mockRestore();
  });

  it("does not warn when no style is requested", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerRecorder(UNSUPPORTED, false);

    await synthesize("a line", `${UNSUPPORTED}/alice`);

    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });
});
