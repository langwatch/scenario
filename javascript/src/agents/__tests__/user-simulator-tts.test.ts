/**
 * User simulator per-run TTS wiring (issue #372 Tier C, Task 5).
 *
 * Two gaps beyond the existing voice-path test (user-simulator-voice.test.ts,
 * which injects `_synthesize`):
 *   1. The DEFAULT `_synthesize` routes through the per-run `voice/tts`
 *      registry (`synthesize()`), not a throwing stub. Proven by registering a
 *      fake TTS provider under a custom prefix — no network, no real keys.
 *   2. Per-run TTS via `cfg.voice.tts.voice` (`run({ voice: { tts } })`) drives
 *      synthesis even when the simulator itself has no `voice=` — the per-run
 *      carrier on ScenarioConfig.voice is honored.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import { AudioChunk } from "../../voice/audio-chunk";
import { extractAudio, messageHasAudio } from "../../voice/messages";
import {
  clearTtsCache,
  registerTtsProvider,
} from "../../voice/tts";
import { userSimulatorAgent, type UserSimulatorAgentConfig } from "../user-simulator-agent";
import type { AgentInput } from "../../domain";

vi.mock("../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-4.1-mini", temperature: 0 },
  }),
}));

function makeInput(voiceTts?: { voice: string }): AgentInput {
  return {
    threadId: "tts-thread",
    messages: [],
    newMessages: [],
    requestedRole: "User" as AgentInput["requestedRole"],
    scenarioConfig: {
      name: "test",
      description: "A test scenario",
      voice: voiceTts ? { tts: voiceTts } : undefined,
    } as AgentInput["scenarioConfig"],
    scenarioState: {} as AgentInput["scenarioState"],
  } as AgentInput;
}

function stubLlm(sim: ReturnType<typeof userSimulatorAgent>, text: string) {
  (sim as unknown as {
    invokeLLM: (p: unknown) => Promise<{ text: string; toolCalls: []; steps: [] }>;
  }).invokeLLM = async () => ({ text, toolCalls: [], steps: [] });
}

describe("UserSimulatorAgent per-run TTS (Task 5)", () => {
  afterEach(() => clearTtsCache());

  it("the DEFAULT _synthesize routes through the per-run voice/tts registry", async () => {
    // Register a fake provider — proves the default path is the real router,
    // not the old throwing stub. PCM16 bytes the registry returns must reach
    // the audio message.
    const synthCalls: Array<{ text: string; name: string }> = [];
    registerTtsProvider({
      prefix: "faketts",
      synth: async (text, name) => {
        synthCalls.push({ text, name });
        return new Uint8Array([10, 20, 30, 40]);
      },
    });

    const sim = userSimulatorAgent({
      voice: "faketts/voiceA",
    } as UserSimulatorAgentConfig);
    stubLlm(sim, "hello from the registry");
    // NOTE: no stubSynth — exercising the real default _synthesize.

    const result = await sim.call(makeInput());

    expect(synthCalls).toHaveLength(1);
    expect(synthCalls[0].text).toBe("hello from the registry");
    expect(synthCalls[0].name).toBe("voiceA");
    expect(messageHasAudio(result)).toBe(true);
    const chunk = extractAudio(result);
    expect(Array.from(chunk!.data)).toEqual([10, 20, 30, 40]);
    expect(chunk!.transcript).toBe("hello from the registry");
  });

  it("per-run cfg.voice.tts.voice drives TTS when the simulator has no voice=", async () => {
    const sim = userSimulatorAgent({} as UserSimulatorAgentConfig);
    stubLlm(sim, "per-run voiced");
    // Inject a recognizable synth so we don't depend on a real provider.
    (sim as unknown as {
      _synthesize: (t: string, v: string) => Promise<AudioChunk>;
    })._synthesize = async (text, voice) => {
      expect(voice).toBe("openai/nova"); // resolved from cfg.voice.tts.voice
      return new AudioChunk({ data: new Uint8Array([1, 2]), transcript: text });
    };

    // The simulator config has NO voice — the per-run carrier supplies it.
    const result = await sim.call(makeInput({ voice: "openai/nova" }));

    expect(messageHasAudio(result)).toBe(true);
    expect(extractAudio(result)!.transcript).toBe("per-run voiced");
  });

  it("no voice anywhere → text-only message (unchanged)", async () => {
    const sim = userSimulatorAgent({} as UserSimulatorAgentConfig);
    stubLlm(sim, "plain");
    const result = await sim.call(makeInput()); // no cfg.voice.tts, no voice=
    expect(messageHasAudio(result)).toBe(false);
    expect((result as { content: unknown }).content).toBe("plain");
  });
});
