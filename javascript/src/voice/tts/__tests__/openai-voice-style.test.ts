/**
 * OpenAI `voiceStyle` mapping (issue #533).
 *
 * `gpt-4o-mini-tts` takes an `instructions` parameter for delivery control, so
 * a named style maps straight onto it. These tests pin BOTH directions: the
 * instruction is present (and carries the style) when one is set, and the key
 * is absent entirely when it is not — an unstyled request must stay exactly
 * the request this callable always sent.
 *
 * The `openai` SDK is module-mocked; no network, no key.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// `vi.mock` factories are hoisted above imports — `vi.hoisted` gives the spy a
// definition that exists by the time the factory runs.
const { speechCreate } = vi.hoisted(() => ({ speechCreate: vi.fn() }));

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    audio = { speech: { create: speechCreate } };
  },
}));

import { openaiTts } from "../openai-tts";

describe("openaiTts voiceStyle → instructions (#533)", () => {
  beforeEach(() => {
    speechCreate.mockReset();
    speechCreate.mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    });
  });

  it("sends an instructions prompt carrying the style", async () => {
    await openaiTts("I'm upset", "nova", { voiceStyle: "angry" });

    expect(speechCreate).toHaveBeenCalledTimes(1);
    const body = speechCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(body["instructions"]).toBe("Speak in a angry tone.");
    // The style must not leak into the spoken text.
    expect(body["input"]).toBe("I'm upset");
    expect(body["voice"]).toBe("nova");
  });

  it("omits the instructions key entirely when no style is set", async () => {
    await openaiTts("I'm upset", "nova");

    const body = speechCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("instructions");
  });

  it("omits the instructions key when options carry no style", async () => {
    await openaiTts("I'm upset", "nova", {});

    const body = speechCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("instructions");
  });
});
