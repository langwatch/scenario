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
 *
 * ## Inline barge-in design (issue #496 — JUDGE-vs-AGENT race fix)
 *
 * The prior design injected USER into `pendingRolesOnTurn` so `_step` would
 * run USER before JUDGE. That still lost the race: the full user-sim LLM+TTS
 * chain (~1.5-3 s) was slower than the pipecat bot's audio reply, so
 * `pendingAgentTask.done` was already `true` by the time USER ran.
 *
 * The current design fires the interrupt INLINE inside
 * `maybeScheduleInterruptedAgentTurn`, right after AGENT is dispatched:
 *
 *   1. AGENT dispatched non-blocking (bot starts streaming)
 *   2. `voiceifyText(phrase)` called immediately (TTS only, no LLM — ~instant
 *      in tests, ~0.5 s in production)
 *   3. `pendingAgentTask.done` check → false (AGENT still in-flight)
 *   4. `fireUserInterrupt(voicedMessage)` waits for bot to speak (agentSpeakingEvent),
 *      then fires the barge-in while AGENT is still draining
 *   5. `user_interrupt` event recorded → assertion 1 passes
 *   6. Truncated segment marked → assertion 2 passes
 *
 * Without this fix, a non-blocking AGENT dispatch followed by JUDGE (a
 * synchronous-null fake or a fast LLM) would drain the agent task before any
 * USER-path check runs — no interrupt fires.
 *
 * The race is now: does TTS alone finish before the bot's first audio chunk?
 * In unit tests, both are instant/40 ms respectively — the race is
 * deterministic. In production, TTS (~0.5 s) is reliably faster than a full
 * bot reply, and `fireUserInterrupt` always waits for `agentSpeakingEvent`
 * before firing, so timing is governed by the bot's speech start, not its end.
 *
 * NOTE: The "meaningfully shorter duration" assertion (ratio < 0.8) is only
 * verifiable with a live voice bot (E2E). In unit tests with fake adapters,
 * JS promises are not cancelable — the full chunk is always drained. That
 * assertion lives in random-interruptions.test.ts (E2E).
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
import { createAudioMessage, extractTranscript } from "../messages";

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
 * A voice agent adapter that emits a reply with a 40 ms delay on the first
 * chunk. This ensures `pendingAgentTask.done === false` when
 * `maybeScheduleInterruptedAgentTurn` fires the inline barge-in, and that
 * `agentSpeakingEvent` is set 40 ms after dispatch — giving `fireUserInterrupt`
 * a real speaking window to barge into.
 *
 * The 40 ms delay models the wall-clock gap between AGENT dispatch and the
 * bot's first audio chunk on a real transport (~0.5-1 s for pipecat/OpenAI).
 * In unit tests it keeps the race deterministic (instant `voiceifyText` +
 * 40 ms speaking delay = always fires before the agent finishes).
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
      // 40 ms delay: models the bot's time-to-first-byte. The inline barge-in
      // in maybeScheduleInterruptedAgentTurn calls voiceifyText (instant here)
      // then awaits agentSpeakingEvent, which fires at this 40 ms mark.
      // Without the fix, a synchronous-null JUDGE would drain this task before
      // any USER check ran and done would be true when the check arrived.
      await sleep(40);
      this.eos = true;
      return tone(1.5, "a very long agent reply that keeps going and going");
    }
    return new AudioChunk({ data: new Uint8Array(0) });
  }
}

/**
 * Voice-capable user simulator: has `voice` + `voiceifyText` so the executor
 * recognises it and routes through the inline barge-in path in
 * `maybeScheduleInterruptedAgentTurn`. Also exposes `interruptProbability` so
 * `resolveInterruptionConfig` picks it up.
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

/**
 * Judge that only resolves on an explicit judgment request (never in proceed).
 *
 * NOTE: No artificial delay here. The inline barge-in fires BEFORE _step runs
 * JUDGE, so JUDGE timing no longer affects the interrupt window. The prior
 * design needed a 100 ms JUDGE delay to model the race; the new inline design
 * does not depend on JUDGE latency at all.
 */
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

// ---------------------------------------------------------------------------
// Helpers for explicit barge-in test (P1)
// ---------------------------------------------------------------------------

/**
 * Minimal voice agent adapter for the explicit barge-in test.
 * Emits one audio chunk after a 40 ms delay (keeping the task in-flight long
 * enough for the barge-in to fire), then signals EOS.  The runtime's
 * defaultVoiceCall sets agentSpeakingEvent when receiveAudio returns its
 * first chunk.
 */
class QuickReplyAgent extends VoiceAgentAdapter {
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
      await sleep(40);
      this.eos = true;
      return tone(0.5, "agent reply");
    }
    return new AudioChunk({ data: new Uint8Array(0) });
  }
}

/**
 * Voice user sim for explicit barge-in test: can TTS any text (no LLM).
 * Does NOT set interruptProbability — the explicit script user() call is the
 * barge-in source here (not maybeScheduleInterruptedAgentTurn).
 */
class ExplicitBargeInUserSim extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  readonly voice = "openai/nova";
  // No interruptProbability: we don't want maybeScheduleInterruptedAgentTurn
  // to fire automatically; the test drives the barge-in explicitly.

  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return createAudioMessage(tone(0.1, "user auto-turn"), "user");
  }

  async voiceifyText(text: string): Promise<ReturnType<typeof createAudioMessage>> {
    return createAudioMessage(tone(0.1, text), "user");
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("proceed-loop voice barge-in (maybeScheduleInterruptedAgentTurn)", () => {
  it(
    "barges in mid-stream and captures the user phrase before the agent finishes speaking",
    async () => {
      const voiceAgent = new LongReplyAgent();
      const userSim = new VoiceUserSim();
      const judge = new PassingJudge();

      const exec = new ScenarioExecution(
        {
          name: "proceed-interrupt / inline barge-in unit",
          description:
            "maybeScheduleInterruptedAgentTurn fires pre-step; inline voiceifyText + " +
            "fireUserInterrupt produces a real mid-stream barge-in without LLM call",
          agents: [voiceAgent, userSim, judge],
        },
        [
          // Step 1: arm the InterruptionConfig on the executor.
          // delayRange:[0,0] keeps the unit test fast and deterministic —
          // the sampleDelay sleep is now honoured in the voice barge-in path
          // (maybeScheduleInterruptedAgentTurn). Production configs use the
          // default [0.5, 3.0]; unit tests must opt out explicitly.
          (_state, executor) => {
            (executor as unknown as { voiceInterruptions: InterruptionConfig }).voiceInterruptions =
              new InterruptionConfig({ probability: 1.0, strategy: "random_phrase", delayRange: [0, 0] });
          },
          // Step 2: proceed for 2 turns (enough for the barge-in path to fire
          // across a turn boundary).
          async (_state, executor) => {
            await executor.proceed(2);
          },
        ],
        "test-batch-id",
      );
      // RNG = 0 → always fires (0 < 1.0) and picks phrase[0].
      exec.interruptOverrides = { rng: () => 0 };

      const result = await exec.execute();

      // 1. A user_interrupt event must be present.
      const interrupts = (result.timeline ?? []).filter(
        (e) => e.type === "user_interrupt",
      );
      expect(
        interrupts.length,
        "no user_interrupt event — proceed-loop pre-step inline barge-in never fired",
      ).toBeGreaterThan(0);

      // 2. The barge-in must have landed mid-utterance (agent was speaking).
      //    "fired_before_speech" means the agent hadn't started yet — nothing cut off.
      const outcome = interrupts[0]!.metadata?.outcome;
      expect(
        outcome,
        "barge-in did not land mid-utterance — agentSpeakingEvent was not awaited " +
          "or the agent task completed before fireUserInterrupt ran",
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
    // 5 s ceiling: actual runtime is ~200 ms (40 ms agent drain + settle + 2 turns).
    5_000,
  );
});

/**
 * P1 regression — explicit script barge-in via `user("barge-in text")` must
 * appear in state.messages so the judge and downstream agents see it.
 *
 * Before the fix, `maybeFireUserInterrupt` returned immediately after firing
 * the audio, skipping the `scriptCallAgent` path that appends + broadcasts
 * the voiced message.  The result: `result.messages` contained no user turn
 * for the barge-in, so the conversation history was incomplete.
 *
 * After the fix, `maybeFireUserInterrupt` itself calls `state.addMessage` +
 * `broadcastMessage` before returning `true`, matching the bookkeeping done
 * by `maybeScheduleInterruptedAgentTurn` for the proceed-loop path.
 */
describe("explicit user() barge-in recorded in state.messages (P1 fix)", () => {
  it(
    "appends and broadcasts the barge-in user message into result.messages",
    async () => {
      const voiceAgent = new QuickReplyAgent();
      const userSim = new ExplicitBargeInUserSim();
      const judge = new PassingJudge();

      const exec = new ScenarioExecution(
        {
          name: "explicit barge-in / state.messages recording",
          description:
            "user('barge-in text') on an in-flight agentNonBlocking turn must " +
            "appear in result.messages — maybeFireUserInterrupt must record it.",
          agents: [voiceAgent, userSim, judge],
        },
        [
          async (_state, executor) => {
            // Fire the agent turn non-blocking (sets pendingAgentTask).
            (executor as unknown as { agentNonBlocking(): void }).agentNonBlocking();
            // Immediately call user() — this triggers the barge-in path via
            // maybeFireUserInterrupt because pendingAgentTask is in-flight.
            await executor.user("barge-in correction");
            // Drain the pending task and end.
            await executor.succeed("done");
          },
        ],
        "test-batch-id",
      );

      const result = await exec.execute();

      // The barge-in user message must be in result.messages.
      const userMessages = result.messages.filter((m) => m.role === "user");
      const bargeInMsg = userMessages.find((m) => {
        const transcript = extractTranscript(m);
        return transcript === "barge-in correction";
      });

      expect(
        bargeInMsg,
        "barge-in user message not found in result.messages — " +
          "maybeFireUserInterrupt did not call state.addMessage before returning",
      ).toBeDefined();
    },
    5_000,
  );
});

/**
 * bargeInDelayMs unit coverage (#582 item 7).
 *
 * Asserts that:
 * - given `bargeInDelayMs > 0`, the barge-in fires after the delay and the
 *   user_interrupt event is still recorded (the delay path doesn't suppress it).
 * - given `bargeInDelayMs = undefined`, no extra delay is introduced and
 *   the barge-in still fires.
 *
 * Uses a minimal 1 ms bargeInDelayMs (real timers) to keep the test fast
 * while still exercising the `(bargeInDelayMs ?? 0) > 0` branch in
 * fireUserInterrupt.
 */
describe("fireUserInterrupt — bargeInDelayMs delay branch", () => {
  it(
    "still fires user_interrupt when bargeInDelayMs > 0 (delay path exercised)",
    async () => {
      const voiceAgent = new LongReplyAgent();
      const userSim = new VoiceUserSim();
      const judge = new PassingJudge();

      const exec = new ScenarioExecution(
        {
          name: "bargeInDelayMs / 1 ms delay",
          description:
            "fireUserInterrupt must sleep bargeInDelayMs after agentSpeakingEvent and still fire",
          agents: [voiceAgent, userSim, judge],
        },
        [
          (_state, executor) => {
            (executor as unknown as { voiceInterruptions: InterruptionConfig }).voiceInterruptions =
              new InterruptionConfig({
                probability: 1.0,
                strategy: "random_phrase",
                delayRange: [0, 0],
              });
          },
          async (_state, executor) => {
            await executor.proceed(2);
          },
        ],
        "test-batch-id",
      );
      // RNG 0 → always fires. bargeInDelayMs = 1 exercises the > 0 branch
      // without meaningfully slowing the test (1 ms real-clock sleep).
      exec.interruptOverrides = { rng: () => 0, bargeInDelayMs: 1 };

      const result = await exec.execute();

      const interrupts = (result.timeline ?? []).filter(
        (e) => e.type === "user_interrupt",
      );
      expect(
        interrupts.length,
        "no user_interrupt fired — bargeInDelayMs > 0 path suppressed or broke the barge-in",
      ).toBeGreaterThan(0);
    },
    5_000,
  );

  it(
    "fires immediately (no extra sleep) when bargeInDelayMs is undefined",
    async () => {
      const voiceAgent = new LongReplyAgent();
      const userSim = new VoiceUserSim();
      const judge = new PassingJudge();

      const exec = new ScenarioExecution(
        {
          name: "bargeInDelayMs / no delay",
          description:
            "fireUserInterrupt must not introduce any delay when bargeInDelayMs is undefined",
          agents: [voiceAgent, userSim, judge],
        },
        [
          (_state, executor) => {
            (executor as unknown as { voiceInterruptions: InterruptionConfig }).voiceInterruptions =
              new InterruptionConfig({
                probability: 1.0,
                strategy: "random_phrase",
                delayRange: [0, 0],
              });
          },
          async (_state, executor) => {
            await executor.proceed(2);
          },
        ],
        "test-batch-id",
      );
      // RNG 0 → always fires. No bargeInDelayMs override → undefined path.
      exec.interruptOverrides = { rng: () => 0 };

      const result = await exec.execute();

      const interrupts = (result.timeline ?? []).filter(
        (e) => e.type === "user_interrupt",
      );
      expect(
        interrupts.length,
        "no user_interrupt fired in the no-delay path",
      ).toBeGreaterThan(0);
    },
    5_000,
  );
});
