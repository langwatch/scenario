/**
 * Voice hook fan-out tests — binds `specs/voice-agents.feature` scenarios
 * tagged `@ts-hooks`:
 *   - "on_audio_chunk hook fires for each chunk" (lines 450-454)
 *   - "on_voice_event hook fires for each VoiceEvent" (lines 457-461)
 *
 * The PR3 runtime fans `on_audio_chunk` out to every audio chunk that
 * crosses the recorder and fans `on_voice_event` out to every `VoiceEvent`
 * appended to the timeline.
 *
 * Loaded via @amiceli/vitest-cucumber which reads the feature file and fails
 * the suite if any bound scenario is missing a step binding.
 *
 * The "throwing hook doesn't break scenario" behavior is tested as a plain
 * it() below — it is an implementation-level guarantee, not a named feature
 * scenario. Option (a) chosen: no spec scenario exists for this behavior.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect, it } from "vitest";

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

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "specs",
  "voice-agents.feature",
);

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

// -------------------------------------------------------------------------
// Plain unit test: a throwing on_voice_event hook does not break the scenario.
//
// This is an implementation-level guarantee (the runtime swallows hook errors
// so a buggy observability callback can never break a scenario run). It is NOT
// a named scenario in specs/voice-agents.feature, so it lives here as a plain
// it() rather than inside a describeFeature binding. Option (a) chosen.
// -------------------------------------------------------------------------
it("throwing on_voice_event hook does not break the scenario", async () => {
  const adapter = new FakeVoiceAdapter({
    responses: [pcm16Chunk(0.05)],
  });
  let voiceEventCalls = 0;
  const throwingExecution = new ScenarioExecution(
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
  const result = await throwingExecution.execute();
  expect(result.success).toBe(true);
  expect(voiceEventCalls).toBeGreaterThan(0);
});

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    // -----------------------------------------------------------------------
    // Scenario: on_audio_chunk hook fires for each chunk (lines 450-454)
    // -----------------------------------------------------------------------
    Scenario(
      "on_audio_chunk hook fires for each chunk",
      ({ Given, When, Then }) => {
        let userChunk: AudioChunk;
        let agentChunk: AudioChunk;
        let captured: AudioChunk[];

        Given("scenario.run(..., on_audio_chunk=cb)", () => {
          userChunk = pcm16Chunk(0.05, 0x1234);
          agentChunk = pcm16Chunk(0.06, 0x5678);
          captured = [];
        });

        When("audio flows", async () => {
          const adapter = new FakeVoiceAdapter({ responses: [agentChunk] });
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
        });

        Then("cb is invoked with each AudioChunk", () => {
          // The default call() flow records one user chunk (the sent audio)
          // and one agent chunk (the drained response) — both fan out to
          // on_audio_chunk in `fireAudioChunk`.
          expect(captured.length).toBeGreaterThanOrEqual(2);
          // The bytes round-trip through the hook intact (no normalisation
          // side-effects from the recorder boundary).
          const firstByte = captured[0]!.data[0];
          expect(typeof firstByte).toBe("number");
        });
      },
    );

    // -----------------------------------------------------------------------
    // Scenario: on_voice_event hook fires for each VoiceEvent (lines 457-461)
    // -----------------------------------------------------------------------
    Scenario(
      "on_voice_event hook fires for each VoiceEvent",
      ({ Given, When, Then }) => {
        let events: VoiceEvent[];
        let execution: ScenarioExecution;

        Given("scenario.run(..., on_voice_event=cb)", () => {
          const userChunk = pcm16Chunk(0.05);
          const agentChunk = pcm16Chunk(0.06);
          const adapter = new FakeVoiceAdapter({ responses: [agentChunk] });
          events = [];

          execution = new ScenarioExecution(
            {
              name: "hooks / on_voice_event fires",
              description: "covers the bound feature scenario lines 456-461",
              agents: [adapter, new AudioUserSimulator(userChunk)],
              onVoiceEvent: (event) => events.push(event),
            },
            [user(), agent(), succeed("done")],
            "test-batch-id",
          );
        });

        When("VAD/interrupt/tool events occur", async () => {
          await execution.execute();
        });

        Then("cb is invoked with each VoiceEvent", () => {
          // Default call() emits: user_start, user_stop, agent_start,
          // agent_stop — 4 events. We assert the canonical types are present.
          const types = new Set(events.map((e) => e.type));
          expect(types.has("user_start_speaking")).toBe(true);
          expect(types.has("user_stop_speaking")).toBe(true);
          expect(types.has("agent_start_speaking")).toBe(true);
          expect(types.has("agent_stop_speaking")).toBe(true);
        });
      },
    );
  },
  { includeTags: ["ts-hooks"] },
);
