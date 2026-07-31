/**
 * `voiceStyle` threading through the user simulator (issue #533).
 *
 * Before #533 the style stopped AT the simulator: `setOneShotOverride({
 * voiceStyle })` installed it, `synthesizeToAudioMessage` emitted a "no TTS
 * provider currently honours it" warning, and `_synthesize` was then called
 * with `(text, voice)` only — the style was dropped on the floor.
 *
 * These tests pin the wiring at the simulator boundary: every source of a
 * style (per-step one-shot override / simulator `voiceStyle` / per-run
 * `voice.tts.voiceStyle`) must reach `_synthesize`'s third argument with the
 * documented precedence, and a one-shot override must not leak into the next
 * turn. Offline — both the LLM and TTS are stubs; no network, no keys.
 */

import { describe, it, expect, vi } from "vitest";

import { AudioChunk } from "../../voice/audio-chunk";
import {
  userSimulatorAgent,
  type UserSimulatorAgentConfig,
} from "../user-simulator-agent";
import type { AgentInput } from "../../domain";

// Mock getProjectConfig to avoid filesystem dependency in unit tests.
vi.mock("../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-4.1-mini", temperature: 0 },
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One recorded `_synthesize(text, voice, voiceStyle)` invocation. */
interface SynthCall {
  text: string;
  voice: string;
  voiceStyle?: string;
}

/**
 * Build a minimal {@link AgentInput} stub, optionally carrying the per-run
 * `voice.tts` carrier (`run({ voice: { tts: { voice, voiceStyle } } })`).
 */
function makeInput(tts?: { voice: string; voiceStyle?: string }): AgentInput {
  return {
    threadId: "voice-style-thread",
    messages: [],
    newMessages: [],
    requestedRole: "User" as AgentInput["requestedRole"],
    scenarioConfig: {
      name: "test",
      description: "A test scenario description",
      voice: tts ? { tts } : undefined,
    } as AgentInput["scenarioConfig"],
    scenarioState: {} as AgentInput["scenarioState"],
  } as AgentInput;
}

/** Wire a stub LLM into the simulator that always returns the given text. */
function stubLlm(sim: ReturnType<typeof userSimulatorAgent>, text: string) {
  (
    sim as unknown as {
      invokeLLM: (
        p: unknown,
      ) => Promise<{ text: string; toolCalls: []; steps: [] }>;
    }
  ).invokeLLM = async () => ({ text, toolCalls: [], steps: [] });
}

/**
 * Replace `_synthesize` with a recorder that appends every `(text, voice,
 * voiceStyle)` triple to `calls` and returns a 4-byte chunk.
 */
function recordSynth(
  sim: ReturnType<typeof userSimulatorAgent>,
  calls: SynthCall[],
) {
  (
    sim as unknown as {
      _synthesize: (
        text: string,
        voice: string,
        voiceStyle?: string,
      ) => Promise<AudioChunk>;
    }
  )._synthesize = async (text, voice, voiceStyle) => {
    calls.push({ text, voice, voiceStyle });
    return new AudioChunk({ data: new Uint8Array(4), transcript: text });
  };
}

// ---------------------------------------------------------------------------

describe("UserSimulatorAgent voiceStyle → _synthesize (#533)", () => {
  it("passes a one-shot override to _synthesize and reverts on the next turn", async () => {
    const config: UserSimulatorAgentConfig = { voice: "openai/nova" };
    const sim = userSimulatorAgent(config);
    stubLlm(sim, "I'm really upset about this!");
    const calls: SynthCall[] = [];
    recordSynth(sim, calls);

    const restore = sim.setOneShotOverride({ voiceStyle: "angry" });
    await sim.call(makeInput());
    restore();
    await sim.call(makeInput());

    expect(calls).toHaveLength(2);
    expect(calls[0].voiceStyle).toBe("angry");
    // Restored — the style must NOT bleed into the following turn.
    expect(calls[1].voiceStyle).toBeUndefined();
    expect(calls[1].voice).toBe("openai/nova");
  });

  it("passes the simulator's configured voiceStyle when no override is installed", async () => {
    const config: UserSimulatorAgentConfig = {
      voice: "openai/nova",
      voiceStyle: "cheerful",
    };
    const sim = userSimulatorAgent(config);
    stubLlm(sim, "hi there");
    const calls: SynthCall[] = [];
    recordSynth(sim, calls);

    await sim.call(makeInput());

    expect(calls).toHaveLength(1);
    expect(calls[0].voiceStyle).toBe("cheerful");
  });

  it("lets a one-shot override beat the configured voiceStyle for one turn only", async () => {
    const config: UserSimulatorAgentConfig = {
      voice: "openai/nova",
      voiceStyle: "cheerful",
    };
    const sim = userSimulatorAgent(config);
    stubLlm(sim, "I'm really upset about this!");
    const calls: SynthCall[] = [];
    recordSynth(sim, calls);

    const restore = sim.setOneShotOverride({ voiceStyle: "angry" });
    await sim.call(makeInput());
    restore();
    await sim.call(makeInput());

    expect(calls[0].voiceStyle).toBe("angry");
    // `_voiceStyleOverride === null` means "no override installed", NOT
    // "force unstyled" — the configured default resumes.
    expect(calls[1].voiceStyle).toBe("cheerful");
  });

  it("passes the per-run voice.tts.voiceStyle when the simulator has none", async () => {
    const sim = userSimulatorAgent({});
    stubLlm(sim, "i guess so");
    const calls: SynthCall[] = [];
    recordSynth(sim, calls);

    await sim.call(makeInput({ voice: "openai/nova", voiceStyle: "sad" }));

    expect(calls).toHaveLength(1);
    expect(calls[0].voice).toBe("openai/nova");
    expect(calls[0].voiceStyle).toBe("sad");
  });

  it("lets the simulator's voiceStyle beat the per-run voice.tts.voiceStyle", async () => {
    const config: UserSimulatorAgentConfig = {
      voice: "openai/nova",
      voiceStyle: "cheerful",
    };
    const sim = userSimulatorAgent(config);
    stubLlm(sim, "hello");
    const calls: SynthCall[] = [];
    recordSynth(sim, calls);

    await sim.call(makeInput({ voice: "openai/alloy", voiceStyle: "sad" }));

    expect(calls).toHaveLength(1);
    // Simulator wins on BOTH axes — voice and style resolve the same way.
    expect(calls[0].voice).toBe("openai/nova");
    expect(calls[0].voiceStyle).toBe("cheerful");
  });

  it("passes the run-level style through voiceifyText (scripted content path)", async () => {
    const sim = userSimulatorAgent({});
    const calls: SynthCall[] = [];
    recordSynth(sim, calls);

    await sim.voiceifyText("I'm really upset about this!", {
      tts: { voice: "openai/nova", voiceStyle: "sad" },
    });

    expect(calls).toEqual([
      {
        text: "I'm really upset about this!",
        voice: "openai/nova",
        voiceStyle: "sad",
      },
    ]);
  });
});
