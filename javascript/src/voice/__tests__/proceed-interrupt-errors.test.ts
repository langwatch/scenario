/**
 * Regression test for P2 (review #4382164555):
 * errors from a background AGENT turn must NOT be swallowed.
 *
 * Before the fix, `maybeScheduleInterruptedAgentTurn` had a bare
 * `.catch(() => {})` that converted any rejection into success.  A voice
 * AGENT whose `call()` threw would cause the scenario to continue silently
 * and pass a later `judge()` / `succeed()` step.
 *
 * After the fix the rejection is captured into `entry.error` and re-thrown
 * inside `fireUserInterrupt` after the promise settles, so the `execute()`
 * promise itself rejects.
 */

import { describe, it, expect } from "vitest";

import {
  AgentRole,
  type AgentInput,
  type AgentReturnTypes,
  JudgeAgentAdapter,
  UserSimulatorAgentAdapter,
} from "../../domain";
import { ScenarioExecution } from "../../execution/scenario-execution";
import { InterruptionConfig } from "../interruption";
import { VoiceAgentAdapter } from "../adapter";
import { AudioChunk } from "../audio-chunk";
import { AdapterCapabilities } from "../capabilities";
import { AgentSpeakingEvent } from "../adapter.runtime";
import { createAudioMessage } from "../messages";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Non-silent PCM16 tone (mono, 24kHz). */
function tone(durationSeconds: number, transcript: string): AudioChunk {
  const numSamples = Math.floor(durationSeconds * 24000);
  const data = new Uint8Array(numSamples * 2);
  const view = new DataView(data.buffer);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(i * 2, ((i * 97) % 20000) - 10000, true);
  }
  return new AudioChunk({ data, transcript });
}

// ---------------------------------------------------------------------------
// Fake adapters
// ---------------------------------------------------------------------------

/**
 * A voice agent adapter whose `call()` sets the speaking event (so
 * `fireUserInterrupt` can barge in), waits 40 ms, then rejects.
 *
 * This exercises the exact path fixed by P2: the rejection must be
 * captured in `entry.error` and re-thrown by `fireUserInterrupt`, causing
 * `execute()` to reject rather than silently succeed.
 */
class FailingVoiceAgent extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  readonly capabilities = new AdapterCapabilities({
    interruption: true,
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendAudio(_c: AudioChunk): Promise<void> {}
  async receiveAudio(_t: number): Promise<AudioChunk> {
    return new AudioChunk({ data: new Uint8Array(0) });
  }

  /**
   * Override call() so we can manually set agentSpeakingEvent BEFORE
   * rejecting — this ensures the barge-in path sees "agent is speaking"
   * and actually awaits the promise, which is where the rethrow happens.
   */
  override async call(_input: AgentInput): Promise<AgentReturnTypes> {
    // Set the speaking event so fireUserInterrupt's agentSpeakingEvent.wait()
    // resolves immediately (bot "started speaking").
    const event = new AgentSpeakingEvent();
    event.set();
    this.agentSpeakingEvent = event;
    // 40 ms delay: ensures pendingAgentTask.done === false when voiceifyText
    // returns (voiceifyText is instant in tests).
    await new Promise((r) => setTimeout(r, 40));
    throw new Error("agent-call-failure");
  }
}

/**
 * Voice-capable user simulator — identical shape to the one in
 * proceed-interrupt.test.ts so the executor routes through
 * maybeScheduleInterruptedAgentTurn.
 */
class VoiceUserSim extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  readonly voice = "openai/nova";
  readonly interruptProbability = 1.0;
  private turn = 0;

  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    this.turn++;
    return createAudioMessage(tone(0.1, `user turn ${this.turn}`), "user");
  }

  async voiceifyText(text: string): Promise<ReturnType<typeof createAudioMessage>> {
    return createAudioMessage(tone(0.1, text), "user");
  }
}

/** Judge that never ends the scenario on its own. */
class NeverEndingJudge extends JudgeAgentAdapter {
  criteria = ["ok"];
  async call(input: AgentInput) {
    if (!input.judgmentRequest) return null;
    return {
      success: true,
      reasoning: "done",
      metCriteria: ["ok"],
      unmetCriteria: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("maybeScheduleInterruptedAgentTurn — rejection propagation (P2 fix)", () => {
  it(
    "rejects execute() when the background AGENT turn throws during voiceProceed({ interruptions })",
    async () => {
      const voiceAgent = new FailingVoiceAgent();
      const userSim = new VoiceUserSim();
      const judge = new NeverEndingJudge();

      const exec = new ScenarioExecution(
        {
          name: "proceed-interrupt-errors / rejection propagation",
          description:
            "A failing voice AGENT dispatched by maybeScheduleInterruptedAgentTurn " +
            "must cause execute() to reject rather than silently succeeding.",
          agents: [voiceAgent, userSim, judge],
        },
        [
          (_state, executor) => {
            (
              executor as unknown as { voiceInterruptions: InterruptionConfig }
            ).voiceInterruptions = new InterruptionConfig({
              probability: 1.0,
              strategy: "random_phrase",
              delayRange: [0, 0],
            });
          },
          async (_state, executor) => {
            await executor.proceed(1);
          },
        ],
        "test-batch-id",
      );
      // RNG = 0 → always fires (0 < 1.0) and picks phrase[0].
      (exec as unknown as { interruptRng: () => number }).interruptRng = () => 0;

      await expect(exec.execute()).rejects.toThrow("agent-call-failure");
    },
    30_000,
  );
});
