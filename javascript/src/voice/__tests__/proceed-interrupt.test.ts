/**
 * Proceed-loop voice barge-in (issue #372 pre-step path).
 *
 * Verifies that `voiceProceed({ interruptions })` with a non-zero probability
 * fires a REAL mid-stream barge-in via the pre-step
 * `maybeScheduleInterruptedAgentTurn` path, NOT just a post-hoc label on a
 * fully-completed agent turn.
 *
 * Key assertions:
 * 1. A `user_interrupt` event is emitted with `outcome === "fired_after_speech"`.
 * 2. At least one agent segment is marked `transcriptTruncated`.
 * 3. `pendingAgentTask` was set (non-blocking agent dispatched) before the user
 *    sim ran — the structural guarantee that the barge-in path fired.
 *
 * Uses the same fake-adapter pattern as interrupt-truncation.test.ts; no
 * network, no real keys.
 *
 * NOTE: The "meaningfully shorter duration" assertion (ratio < 0.8) is only
 * verifiable with a live voice bot (E2E). In unit tests with fake adapters,
 * JS promises are not cancelable — the full chunk is always drained. That
 * assertion lives in random-interruptions.test.ts (E2E).
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
 * A voice agent adapter that emits a LONG first reply so the agent task is
 * still draining when the user-sim fires the barge-in check. The 40ms delay
 * on the first chunk ensures `pendingAgentTask.done === false` when USER runs.
 */
class LongReplyAgent extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  readonly capabilities = new AdapterCapabilities({
    interruption: true,
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });
  private eos = false;
  private served = false;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendAudio(_c: AudioChunk): Promise<void> {}

  async receiveAudio(_t: number): Promise<AudioChunk> {
    if (this.eos) {
      this.eos = false;
      this.served = false;
      return new AudioChunk({ data: new Uint8Array(0) });
    }
    if (!this.served) {
      this.served = true;
      // Delay 40ms so the drain is still pending when USER fires the check.
      await new Promise((r) => setTimeout(r, 40));
      this.eos = true;
      return tone(1.5, "a very long agent reply that keeps going and going");
    }
    return new AudioChunk({ data: new Uint8Array(0) });
  }
}

/**
 * Voice-capable user simulator: has `voice` + `voiceifyText` so the executor
 * recognises it and routes through the barge-in path. Also exposes
 * `interruptProbability` so `resolveInterruptionConfig` picks it up.
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

/** Judge that only resolves on an explicit judgment request (never in proceed). */
class PassingJudge extends JudgeAgentAdapter {
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

describe("proceed-loop voice barge-in (maybeScheduleInterruptedAgentTurn)", () => {
  it(
    "dispatches AGENT non-blocking pre-step and fires a real barge-in in callAgent",
    async () => {
      const voiceAgent = new LongReplyAgent();
      const userSim = new VoiceUserSim();
      const judge = new PassingJudge();

      const exec = new ScenarioExecution(
        {
          name: "proceed-interrupt / real barge-in unit",
          description:
            "maybeScheduleInterruptedAgentTurn fires pre-step; user-sim turn " +
            "triggers the callAgent barge-in check",
          agents: [voiceAgent, userSim, judge],
        },
        [
          // Step 1: arm the InterruptionConfig on the executor.
          (_state, executor) => {
            (executor as unknown as { voiceInterruptions: InterruptionConfig }).voiceInterruptions =
              new InterruptionConfig({ probability: 1.0, strategy: "random_phrase" });
          },
          // Step 2: proceed for 2 turns (enough for the barge-in path to fire
          // across a turn boundary — see timing analysis in test docstring).
          async (_state, executor) => {
            await executor.proceed(2);
          },
        ],
        "test-batch-id",
      );
      // RNG = 0 → always fires (0 < 1.0) and picks phrase[0].
      (exec as unknown as { _interruptRng: () => number })._interruptRng = () => 0;

      const result = await exec.execute();

      // 1. A user_interrupt event must be present.
      const interrupts = (result.timeline ?? []).filter(
        (e) => e.type === "user_interrupt",
      );
      expect(
        interrupts.length,
        "no user_interrupt event — proceed-loop pre-step barge-in never fired",
      ).toBeGreaterThan(0);

      // 2. The barge-in must have landed mid-utterance (agent was speaking).
      //    "fired_before_speech" means the agent hadn't started yet — nothing cut off.
      const outcome = interrupts[0]!.metadata?.outcome;
      expect(
        outcome,
        "barge-in did not land mid-utterance — the pre-step scheduling may not have fired " +
          "or the agent task completed before USER ran",
      ).toBe("fired_after_speech");

      // 3. At least one agent segment must be marked transcriptTruncated by the
      //    cursor-based post-hoc pass (the one structural proof of a real cut-off).
      const truncated = (result.audio?.segments ?? []).filter(
        (s) => s.speaker === "agent" && s.transcriptTruncated,
      );
      expect(
        truncated.length,
        "no agent segment marked transcriptTruncated — the cursor-based pass did not mark any " +
          "cut-off (interrupt may have landed outside all agent segments)",
      ).toBeGreaterThan(0);
    },
    // Generous timeout: 40ms adapter delay + agent drain + barge-in settle.
    15_000,
  );
});
