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

import { sleep } from "../utils";

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
    await sleep(40);
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

// ---------------------------------------------------------------------------
// P2: stale interruptBargeInDelayMs cleared on TTS failure
// ---------------------------------------------------------------------------

/**
 * A voice agent whose first `call()` triggers a TTS failure on the user sim,
 * then proceeds normally on the second call.  We need the agent to stay
 * in-flight long enough that `pendingAgentTask.done === false` when the
 * barge-in check runs.
 */
class SlowSpeakingAgent extends VoiceAgentAdapter {
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
      // 40 ms delay: keeps pendingAgentTask.done === false when voiceifyText
      // runs (voiceifyText is instant for TtsFailOnceUserSim). The runtime
      // sets agentSpeakingEvent after this receiveAudio returns, so
      // fireUserInterrupt will see it set immediately.
      await sleep(40);
      this.eos = true;
      return new AudioChunk({
        data: new Uint8Array(48000 * 2), // 1 s at 24kHz
        transcript: "agent reply",
      });
    }
    return new AudioChunk({ data: new Uint8Array(0) });
  }
}

/**
 * User sim whose first `voiceifyText` call throws and whose second succeeds.
 */
class TtsFailOnceUserSim extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  readonly voice = "openai/nova";
  readonly interruptProbability = 1.0;

  private voiceifyCallCount = 0;

  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return createAudioMessage(
      new AudioChunk({ data: new Uint8Array(2400), transcript: "user turn" }),
      "user",
    );
  }

  async voiceifyText(text: string): Promise<ReturnType<typeof createAudioMessage>> {
    this.voiceifyCallCount++;
    if (this.voiceifyCallCount === 1) {
      // Simulate TTS failure on first barge-in attempt.
      throw new Error("tts-failure-first-call");
    }
    return createAudioMessage(
      new AudioChunk({ data: new Uint8Array(2400), transcript: text }),
      "user",
    );
  }
}

describe("maybeScheduleInterruptedAgentTurn — stale interruptBargeInDelayMs cleared on TTS failure (P2 fix)", () => {
  it(
    "clears interruptBargeInDelayMs after voiceifyText throws so the next barge-in starts fresh",
    async () => {
      const voiceAgent = new SlowSpeakingAgent();
      const userSim = new TtsFailOnceUserSim();
      const judge = new NeverEndingJudge();

      const exec = new ScenarioExecution(
        {
          name: "proceed-interrupt-errors / stale delay cleared on TTS failure",
          description:
            "When voiceifyText throws on a barge-in attempt, interruptBargeInDelayMs " +
            "must be cleared so the next successful barge-in starts with a fresh delay.",
          agents: [voiceAgent, userSim, judge],
        },
        [
          async (_state, executor) => {
            // Non-zero delayRange so interruptBargeInDelayMs is set (to 1000 ms
            // with sampleDelay RNG=1) before voiceifyText is called on the barge-in turn.
            (
              executor as unknown as { voiceInterruptions: InterruptionConfig }
            ).voiceInterruptions = new InterruptionConfig({
              probability: 1.0,
              strategy: "random_phrase",
              delayRange: [0.5, 1.0],
            });

            // Run 2 turns.  The interruption fires on turn 2's AGENT step
            // (after USER has been processed in turn 1).  voiceifyText throws
            // on the first call → catch block runs → must clear
            // interruptBargeInDelayMs to undefined.  Because RNG returns 0 for
            // the first call (fires the barge-in) and 1 for subsequent calls
            // (skips subsequent barge-ins), only ONE barge-in attempt runs.
            // After proceed(2) returns, no successful fireUserInterrupt has
            // consumed the field — so the field value reflects whether the
            // catch block cleared it (fix) or left it stale (no fix).
            await executor.proceed(2);
          },
        ],
        "test-batch-id",
      );

      // RNG strategy:
      //   call 0 (probability check): returns 0 → 0 < 1.0 → barge-in fires
      //   call 1 (sampleDelay):       returns 1 → delay = 0.5 + 1*(1.0-0.5) = 1.0 s → 1000 ms
      //   call 2 (pickRandomPhrase):  returns 1 → picks last phrase
      //   call 3+ (next probability): returns 1 → 1 ≥ 1.0 → skips further barge-ins
      // Net: exactly ONE barge-in attempt fires (and fails). No successful
      // fireUserInterrupt runs to consume interruptBargeInDelayMs.
      let rngCallCount = 0;
      exec.interruptOverrides = {
        rng: () => (rngCallCount++ === 0 ? 0 : 1),
      };

      await exec.execute();

      // After the run, interruptBargeInDelayMs must be undefined.
      // - With fix: the catch block cleared it to undefined.
      // - Without fix: still 500ms (stale from the failed attempt).
      // No successful fireUserInterrupt ran (second barge-in was skipped), so
      // the field has NOT been consumed by a success path — it remains as-set
      // by the catch (fix: undefined) or as-set by the sample (no fix: 500ms).
      const remainingDelay = exec.interruptBargeInDelayMs;

      expect(
        remainingDelay,
        "interruptBargeInDelayMs was not cleared after TTS failure — " +
          "a stale 1000ms delay from the failed attempt would leak to the next barge-in",
      ).toBeUndefined();
    },
    5_000,
  );
});

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
            // Use undefined turns so the proceed loop runs a second iteration
            // (after USER finishes) where maybeScheduleInterruptedAgentTurn sees
            // AGENT as the next role and fires the interruption. proceed(1) from
            // currentTurn=0 with a pre-populated pendingRolesOnTurn=[USER,AGENT,JUDGE]
            // computes goToNextTurn=false and exits after only USER runs — the
            // interruption path never gets to dispatch AGENT.
            await executor.proceed(undefined);
          },
        ],
        "test-batch-id",
      );
      // RNG = 0 → always fires (0 < 1.0) and picks phrase[0].
      exec.interruptOverrides = { rng: () => 0 };

      await expect(exec.execute()).rejects.toThrow("agent-call-failure");
    },
    5_000,
  );
});
