/**
 * Focused unit test for AC7 of issue #638:
 * UserSimulatorAgent.voiceifyText with NO voice resolved must
 * (a) return the text message unchanged and
 * (b) emit a console.warn containing "no voice resolved".
 *
 * Empty-text is a legitimate no-op — no warn expected in that case.
 * Keyless: no LLM/TTS calls are made.
 */

import { describe, it, expect, vi } from "vitest";

import { userSimulatorAgent } from "../user-simulator-agent";

// Mock getProjectConfig so the module loads without a real filesystem config.
vi.mock("../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-4.1-mini", temperature: 0 },
  }),
}));

describe("UserSimulatorAgent.voiceifyText — no voice resolved (AC7 #638)", () => {
  it("warns and returns text when no voice resolves", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // No voice in config, no run-level voice → no voice resolves.
    const sim = userSimulatorAgent({});
    const msg = await sim.voiceifyText("Hello, I have a question.");

    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Hello, I have a question.");

    expect(warn).toHaveBeenCalled();
    const calledWithNoVoice = warn.mock.calls.some((args) =>
      typeof args[0] === "string" && args[0].includes("no voice resolved"),
    );
    expect(calledWithNoVoice).toBe(true);

    warn.mockRestore();
  });

  it("does NOT warn when text is empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const sim = userSimulatorAgent({});
    const msg = await sim.voiceifyText("");

    expect(msg.role).toBe("user");
    expect(msg.content).toBe("");

    const warnedNoVoice = warn.mock.calls.some((args) =>
      typeof args[0] === "string" && args[0].includes("no voice resolved"),
    );
    expect(warnedNoVoice).toBe(false);

    warn.mockRestore();
  });
});
