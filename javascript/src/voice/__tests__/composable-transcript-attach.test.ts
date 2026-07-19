/**
 * #734 / #735 P1 — ComposableVoiceAgent attaches its own LLM reply as the chunk
 * transcript, so the default call path never grace-waits or STT-transcribes text
 * it already generated.
 *
 * ComposableVoiceAgent inherits `defaultVoiceCall`. Before this fix its
 * `receiveAudio` returned a TTS chunk with NO transcript, and it exposes its
 * text on `lastLlmResponse` (not `lastAgentTranscript`). So a Composable turn
 * fell through to the grace-wait AND then to the simulator's STT fallback —
 * re-transcribing audio it had just synthesized from known text. The turn ALREADY
 * knows its exact words; this test locks that they ride on the returned chunk.
 */
import type { LanguageModel } from "ai";
import { describe, it, expect, vi } from "vitest";

import { AudioChunk } from "../audio-chunk";
import type { STTProvider } from "../stt";

// Stub the TTS router so `synthesize` yields known bytes with no network/provider.
vi.mock("../tts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tts")>();
  return {
    ...actual,
    synthesize: vi.fn(async () => new AudioChunk({ data: new Uint8Array([9, 9, 9, 9]) })),
  };
});

// Import AFTER the mock is registered.
const { ComposableVoiceAgent } = await import("../adapters/composable");

const stubStt: STTProvider = {
  async transcribe(): Promise<string> {
    return "user said hello";
  },
};

/** Minimal ai-sdk LanguageModel stub returning a fixed reply. */
function stubLlm(text: string): LanguageModel {
  return {
    specificationVersion: "v3" as const,
    provider: "fake",
    modelId: "fake-model",
    supportedUrls: {},
    doGenerate: async () => ({
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      content: [{ type: "text", text }],
      warnings: [],
    }),
    doStream: async () => {
      throw new Error("doStream not implemented in stub");
    },
  } as unknown as LanguageModel;
}

describe("#735 P1 — ComposableVoiceAgent carries its LLM reply as the chunk transcript", () => {
  it("attaches lastLlmResponse text to the returned receiveAudio chunk", async () => {
    const agent = new ComposableVoiceAgent({
      stt: stubStt,
      llm: stubLlm("here are your two options: blue and red"),
      tts: "openai/nova",
    });

    // Drive one turn: user audio in (STT), then drain one agent chunk (LLM + TTS).
    await agent.sendAudio(new AudioChunk({ data: new Uint8Array([1, 2, 3, 4]) }));
    const chunk = await agent.receiveAudio(30);

    // The turn's exact generated words ride on the chunk — so
    // attachAgentTurnTranscript labels it directly, and defaultVoiceCall skips the
    // grace-wait (merged.transcript set) and the simulator skips STT.
    expect(chunk.transcript).toBe("here are your two options: blue and red");
    expect(chunk.data.length).toBeGreaterThan(0);
    expect(agent.lastLlmResponse).toBe("here are your two options: blue and red");
  });

  it("does not fabricate a transcript when the LLM returns empty text", async () => {
    const agent = new ComposableVoiceAgent({
      stt: stubStt,
      llm: stubLlm(""),
      tts: "openai/nova",
    });

    await agent.sendAudio(new AudioChunk({ data: new Uint8Array([1, 2, 3, 4]) }));
    const chunk = await agent.receiveAudio(30);

    // Empty reply → no transcript attached (nothing to label the turn with).
    expect(chunk.transcript).toBeUndefined();
  });
});
