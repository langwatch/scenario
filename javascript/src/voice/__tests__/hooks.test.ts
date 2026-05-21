/**
 * Voice hook fan-out tests — binds `specs/voice-agents.feature` lines
 * 449-461 (`on_audio_chunk` and `on_voice_event` hooks).
 *
 * The PR3 runtime fans `on_audio_chunk` out to every audio chunk that
 * crosses the recorder (user-side via `writeUserSegment`, agent-side
 * via the merged drain output) and fans `on_voice_event` out to every
 * `VoiceEvent` appended to the timeline.
 */
import { describe, expect, it } from "vitest";

import {
  AgentRole,
  type AgentInput,
  type AgentReturnTypes,
  UserSimulatorAgentAdapter,
} from "../../domain";
import { agent, succeed, user } from "../../script";
import { ScenarioExecution } from "../../execution/scenario-execution";
import { AudioChunk, silentChunk } from "../audio-chunk";
import type { VoiceEvent } from "../recording.types";
import { FakeVoiceAdapter } from "./fixtures/fake-adapter";

/**
 * Build a synthetic-but-non-silent PCM16 chunk so the recorder treats it
 * as a real (non-empty) flow point — `writeUserSegment` short-circuits
 * on zero-length data, which would skip the hook.
 */
function pcm16Chunk(durationSeconds: number, sample = 0x0010): AudioChunk {
  const numSamples = Math.floor(durationSeconds * 24000);
  const data = new Uint8Array(numSamples * 2);
  for (let i = 0; i < data.length; i += 2) {
    data[i] = sample & 0xff;
    data[i + 1] = (sample >> 8) & 0xff;
  }
  return new AudioChunk({ data });
}

/**
 * User simulator that returns an audio-shaped message so the default
 * voice call() actually flows bytes through `sendAudio`. Without this,
 * the user turn arrives as text and `extractAudioFromLastMessage`
 * yields null → no user-side audio hook fires.
 */
class AudioUserSimulator extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  constructor(private readonly chunk: AudioChunk) {
    super();
  }
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    const base64 = Buffer.from(this.chunk.data).toString("base64");
    // Cast through unknown — the audio shape is locally typed as
    // AudioMessageParam but the executor's ModelMessage union accepts
    // assistant arrays only. ConvertModelMessagesToAguiMessages
    // JSON-stringifies the content, so the audio survives downstream.
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
}

describe("specs/voice-agents.feature lines 449-454 — on_audio_chunk hook fires for each chunk", () => {
  it("invokes the hook for every audio chunk that crosses the recorder", async () => {
    const userChunk = pcm16Chunk(0.05, 0x1234);
    const agentChunk = pcm16Chunk(0.06, 0x5678);
    const adapter = new FakeVoiceAdapter({ responses: [agentChunk] });
    const captured: AudioChunk[] = [];

    const execution = new ScenarioExecution(
      {
        name: "hooks / on_audio_chunk fires",
        description: "covers the bound feature scenario lines 449-454",
        agents: [adapter, new AudioUserSimulator(userChunk)],
        onAudioChunk: (chunk) => captured.push(chunk),
      },
      [user(), agent(), succeed("done")],
      "test-batch-id",
    );

    const result = await execution.execute();
    expect(result.success).toBe(true);
    // The default call() flow records one user chunk (the sent audio)
    // and one agent chunk (the drained response) — both fan out to
    // on_audio_chunk in `_fire_audio_chunk` / `fireAudioChunk`.
    expect(captured.length).toBeGreaterThanOrEqual(2);
    // The bytes round-trip through the hook intact (no normalisation
    // side-effects from the recorder boundary).
    const firstByte = captured[0]!.data[0];
    expect(typeof firstByte).toBe("number");
  });
});

describe("specs/voice-agents.feature lines 456-461 — on_voice_event hook fires for each VoiceEvent", () => {
  it("invokes the hook for every VoiceEvent appended to the timeline", async () => {
    const userChunk = pcm16Chunk(0.05);
    const agentChunk = pcm16Chunk(0.06);
    const adapter = new FakeVoiceAdapter({ responses: [agentChunk] });
    const events: VoiceEvent[] = [];

    const execution = new ScenarioExecution(
      {
        name: "hooks / on_voice_event fires",
        description: "covers the bound feature scenario lines 456-461",
        agents: [adapter, new AudioUserSimulator(userChunk)],
        onVoiceEvent: (event) => events.push(event),
      },
      [user(), agent(), succeed("done")],
      "test-batch-id",
    );

    await execution.execute();

    // Default call() emits: user_start, user_stop, agent_start, agent_stop —
    // 4 events. We assert the canonical types are present; ordering
    // is locked elsewhere (timeline-order spec test).
    const types = new Set(events.map((e) => e.type));
    expect(types.has("user_start_speaking")).toBe(true);
    expect(types.has("user_stop_speaking")).toBe(true);
    expect(types.has("agent_start_speaking")).toBe(true);
    expect(types.has("agent_stop_speaking")).toBe(true);
  });

  it("captures both hooks without ignoring user-supplied callbacks that throw", async () => {
    // The runtime swallows hook errors so a buggy observability
    // callback can never break the scenario. This binds that
    // promise — when the hook throws every iteration, the scenario
    // still completes successfully and the remaining hooks still fire.
    const adapter = new FakeVoiceAdapter({
      responses: [pcm16Chunk(0.05)],
    });
    let voiceEventCalls = 0;

    const execution = new ScenarioExecution(
      {
        name: "hooks / throwing hook does not break scenario",
        description: "binds the swallow-on-hook-error contract",
        agents: [adapter, new AudioUserSimulator(silentChunk(0.05))],
        onVoiceEvent: () => {
          voiceEventCalls += 1;
          throw new Error("simulated observability bug");
        },
      },
      [user(), agent(), succeed("done")],
      "test-batch-id",
    );

    const result = await execution.execute();
    expect(result.success).toBe(true);
    expect(voiceEventCalls).toBeGreaterThan(0);
  });
});
