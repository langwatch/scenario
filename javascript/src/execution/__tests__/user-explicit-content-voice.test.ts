/**
 * Executor `user("text")` voice routing — parity with
 * python/scenario/scenario_executor.py:user (issue #372).
 *
 * REGRESSION GUARD: a scripted `scenario.user("...")` line with a
 * voice-capable user simulator must reach the agent under test as AUDIO, not
 * a text-only message. Without the executor's voiceify-explicit-content
 * branch, voice agents (OpenAI Realtime, ElevenLabs hosted, Pipecat, …) saw
 * a bare text message, sent no audio, and their `call()` timed out draining a
 * response that was never prompted. Offline — `_synthesize` is stubbed, no
 * network, no real keys.
 */

import { describe, it, expect } from "vitest";

import {
  AgentRole,
  AgentAdapter,
  type AgentInput,
  type AgentReturnTypes,
} from "../../domain";
import { ScenarioExecution } from "../scenario-execution";
import { user, agent } from "../../script";
import { userSimulatorAgent } from "../../agents/user-simulator-agent";
import { AudioChunk } from "../../voice/audio-chunk";
import { extractAudio } from "../../voice/messages";
import { FakeVoiceAdapter } from "../../voice/__tests__/fixtures/fake-adapter";

/** Deterministic offline TTS stub: PCM16 bytes proportional to text length. */
function stubSynthesize(text: string): Promise<AudioChunk> {
  // 100 samples/char of non-silent PCM16 so extractAudio yields real bytes.
  const samples = Math.max(100, text.length * 100);
  const data = new Uint8Array(samples * 2);
  for (let i = 0; i < data.length; i += 2) {
    data[i] = 0x10;
    data[i + 1] = 0x20;
  }
  return Promise.resolve(new AudioChunk({ data, transcript: text }));
}

describe('executor user("text") voice routing (#372 parity)', () => {
  it("voiceifies a scripted user line into audio that reaches the agent", async () => {
    const fakeAgent = new FakeVoiceAdapter();
    const sim = userSimulatorAgent({ voice: "openai/nova" });
    // Stub the per-turn synthesizer so the test is offline + deterministic.
    (
      sim as unknown as {
        _synthesize: (t: string, v: string) => Promise<AudioChunk>;
      }
    )._synthesize = (t) => stubSynthesize(t);

    const execution = new ScenarioExecution(
      {
        name: "user-voiceify-routing",
        description: "scripted user line must reach a voice agent as audio",
        agents: [fakeAgent, sim],
      },
      [user("Hello, can you help me?"), agent()],
      "batch-test",
    );

    await execution.execute();

    // The agent under test received exactly one audio chunk — the voiceified
    // user line — NOT a text message that would have left sentAudio empty.
    expect(fakeAgent.sentAudio.length).toBeGreaterThan(0);
    expect(fakeAgent.sentAudio[0]!.data.length).toBeGreaterThan(0);
  });

  it("voiceified user message carries the scripted transcript", async () => {
    // The audio message on the bus must round-trip back to a chunk whose
    // transcript is the scripted text (the producer half of the Gap #3 seam).
    const sim = userSimulatorAgent({ voice: "openai/nova" });
    (
      sim as unknown as {
        _synthesize: (t: string, v: string) => Promise<AudioChunk>;
      }
    )._synthesize = (t) => stubSynthesize(t);

    const message = await sim.voiceifyText("Reset my password please");
    const chunk = extractAudio(message as unknown as Parameters<typeof extractAudio>[0]);
    expect(chunk).not.toBeNull();
    expect(chunk!.transcript).toBe("Reset my password please");
  });

  it("a text-only user agent (no voice) still gets a plain text message", async () => {
    // Without a voice on the simulator, the explicit-content path falls
    // through to the normal text routing (back-compat).
    const seen: AgentInput[] = [];
    class TextAgent extends AgentAdapter {
      role = AgentRole.AGENT;
      async call(input: AgentInput): Promise<AgentReturnTypes> {
        seen.push(input);
        return { role: "assistant" as const, content: "ok" };
      }
    }
    const textAgent = new TextAgent();
    const sim = userSimulatorAgent(); // no voice

    const execution = new ScenarioExecution(
      {
        name: "user-text-fallthrough",
        description: "text-only run keeps the plain text path",
        agents: [textAgent, sim],
      },
      [user("Hello there"), agent()],
      "batch-test",
    );
    await execution.execute();

    // The agent saw a plain string user message (no audio file part).
    const lastUser = seen[0]?.messages.find((m) => m.role === "user");
    expect(lastUser?.content).toBe("Hello there");
  });
});
