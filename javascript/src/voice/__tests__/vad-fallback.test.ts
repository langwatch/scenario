/**
 * VAD-fallback tests — binds `specs/voice-agents.feature` lines 772-791
 * (`SDK-side VAD fallback activates on adapters without native VAD`, the
 * one-shot warning, and the "native-VAD adapters do not trigger
 * fallback" guarantee).
 *
 * The fallback is purely declarative — the adapter's
 * `capabilities.nativeVad === false` triggers the runtime to instantiate
 * a {@link WebRTCVadFallback} and route incoming audio chunks through
 * it. Native-VAD adapters bypass the fallback entirely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentRole,
  type AgentInput,
  type AgentReturnTypes,
  UserSimulatorAgentAdapter,
} from "../../domain";
import { agent, succeed, user } from "../../script";
import { ScenarioExecution } from "../../execution/scenario-execution";
import { AudioChunk } from "../audio-chunk";
import type { VoiceEvent } from "../recording.types";
import { WebRTCVadFallback } from "../vad";
import { FakeVoiceAdapter } from "./fixtures/fake-adapter";

function speechChunk(durationSeconds: number): AudioChunk {
  // Loud sine-ish shape: alternate ±20000 samples — RMS ≈ 20000, comfortably
  // above the fallback's 500-amplitude threshold so the energy detector
  // flips to "speaking" within the hysteresis window.
  const numSamples = Math.floor(durationSeconds * 24000);
  const data = new Uint8Array(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const sample = i % 2 === 0 ? 20000 : -20000;
    const u = sample < 0 ? sample + 0x10000 : sample;
    data[2 * i] = u & 0xff;
    data[2 * i + 1] = (u >> 8) & 0xff;
  }
  return new AudioChunk({ data });
}

function audioMessageContent(chunk: AudioChunk): AgentReturnTypes {
  const base64 = Buffer.from(chunk.data).toString("base64");
  return {
    role: "user",
    content: [
      {
        type: "input_audio",
        input_audio: { data: base64, format: "pcm16" },
      },
    ],
  } as unknown as AgentReturnTypes;
}

class AudioUserSimulator extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  constructor(private readonly chunk: AudioChunk) {
    super();
  }
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return audioMessageContent(this.chunk);
  }
}

beforeEach(() => {
  WebRTCVadFallback.resetWarnings();
});

let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  consoleWarnSpy.mockRestore();
});

describe("specs/voice-agents.feature lines 772-777 — SDK-side VAD fallback activates on adapters without native VAD", () => {
  it("emits user_start_speaking / user_stop_speaking via the fallback when nativeVad=false", async () => {
    const adapter = new FakeVoiceAdapter({
      capabilities: { nativeVad: false },
    });
    const events: VoiceEvent[] = [];

    const execution = new ScenarioExecution(
      {
        name: "vad / fallback emits speaking events",
        description: "binds the bound feature scenario lines 772-777",
        agents: [adapter, new AudioUserSimulator(speechChunk(0.3))],
        onVoiceEvent: (e) => events.push(e),
      },
      [user(), agent(), succeed("done")],
      "test-batch-id",
    );

    await execution.execute();

    // The fallback's events carry `metadata.source === "vad-fallback"` so
    // we can distinguish them from the recorder's own user_start /
    // user_stop pairs and assert the fallback actually drove this.
    const fallbackStarts = events.filter(
      (e) =>
        e.type === "user_start_speaking" &&
        e.metadata?.source === "vad-fallback",
    );
    expect(fallbackStarts.length).toBeGreaterThan(0);
  });

  it("emits a one-shot UserWarning-equivalent on first activation per adapter", async () => {
    // Each adapter class generates ONE warning — the second adapter of
    // the same name does not re-warn (matches Python `_warned_adapters`
    // memoisation at vad.py:39-55).
    new WebRTCVadFallback("FakeVoiceAdapter");
    new WebRTCVadFallback("FakeVoiceAdapter");
    new WebRTCVadFallback("AnotherFakeAdapter");

    const warnCalls = consoleWarnSpy.mock.calls;
    const fakeAdapterWarns = warnCalls.filter((args) =>
      String(args[0]).includes("FakeVoiceAdapter"),
    );
    const otherWarns = warnCalls.filter((args) =>
      String(args[0]).includes("AnotherFakeAdapter"),
    );

    expect(fakeAdapterWarns).toHaveLength(1);
    expect(otherWarns).toHaveLength(1);
    expect(String(fakeAdapterWarns[0]![0])).toMatch(/no native VAD/);
    expect(String(fakeAdapterWarns[0]![0])).toMatch(/Accuracy may differ/);
  });
});

describe("specs/voice-agents.feature lines 786-791 — Adapters with native VAD do not trigger the fallback", () => {
  it("does NOT instantiate the fallback when nativeVad=true", async () => {
    // We assert by absence-of-warning: the fallback's one-shot warning
    // is the only side-effect that fires on instantiation, so its
    // absence proves no fallback was created.
    const adapter = new FakeVoiceAdapter({
      capabilities: { nativeVad: true },
    });

    const execution = new ScenarioExecution(
      {
        name: "vad / native VAD bypasses fallback",
        description: "binds the bound feature scenario lines 786-791",
        agents: [adapter, new AudioUserSimulator(speechChunk(0.2))],
      },
      [user(), agent(), succeed("done")],
      "test-batch-id",
    );

    await execution.execute();

    expect(consoleWarnSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/no native VAD/),
    );
  });
});
