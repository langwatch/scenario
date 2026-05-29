/**
 * E2E demo — interruption recovery (§6.2), the FLAGSHIP voice capability.
 *
 * A MULTI-TURN conversation that interrupts the agent mid-utterance TWICE,
 * via the two documented forms (PRD §4.4):
 *
 *   1. Unrolled primitive: `scenario.agent({ wait: false })` starts the bot's
 *      reply in the background, then a fresh `scenario.user(...)` overlaps it —
 *      the executor waits for the agent to actually start speaking, fires the
 *      transport barge-in, and sends the correction.
 *   2. Sugar: `scenario.interrupt(...)` — identical behavior, one step.
 *
 * The agent under test is the bundled Pipecat stub bot (OpenAI STT+LLM+TTS over
 * the Twilio Media Streams protocol), which supports barge-in (server-side VAD
 * gating).
 *
 * GREET-FIRST opener: the bundled bot emits a canned greeting the instant the
 * socket connects (bot.py, `connected` event). The script therefore OPENS with
 * `scenario.agent()` so that greeting is captured as its own turn — the same
 * shape as the other connect-greeting demos (angry_customer / basic_greeting /
 * random_interruptions). If the script led with the user instead, the greeting
 * would collide with the user's opener: the first barge-in would cut off the
 * GREETING (not a substantive reply) and the bot would answer a stale topic.
 * This intentionally diverges from the (user-first) Python twin
 * `python/examples/voice/interruption_recovery.py`, which is the way it should
 * be for a bot that greets on connect.
 *
 * On success the recording lands in
 * `javascript/examples/vitest/outputs/recordings/interruption_recovery/` (full.wav + manifest only).
 *
 * Binds `@e2e @ts-interruption-recovery-demo`. Env-gated on `OPENAI_API_KEY`
 * AND a reachable bot socket (`SCENARIO_PIPECAT_BOT_UP=1`, set by the runner
 * once `make voice-pipecat-up` reports ready).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import scenario, { type ScenarioResult } from "@langwatch/scenario";
import { expect } from "vitest";

import { saveDemoRecording } from "./helpers/save-demo-recording";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  "specs",
  "voice-agents.feature",
);

const BOT_WS_URL = process.env.PIPECAT_BOT_URL ?? "ws://localhost:8765/stream";
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const botUp = process.env.SCENARIO_PIPECAT_BOT_UP === "1";
const RUN_E2E = hasOpenAI && botUp;

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    const Bind = RUN_E2E ? Scenario : Scenario.skip;

    Bind(
      "Demo — interruption recovery (barge-in via agent({ wait: false }) + interrupt())",
      ({ Given, When, Then, And }) => {
        let result: ScenarioResult | null = null;
        let recordingDir: string | null = null;

        Given(
          "a local Pipecat bot on ws://localhost:8765/stream that supports barge-in",
          () => {
            expect(RUN_E2E).toBe(true);
          },
        );

        When(
          "the demo script interrupts the agent mid-utterance and the agent recovers",
          async () => {
            result = await scenario.run({
              name: "demo_interruption_recovery",
              description:
                "The bot greets on connect; the user asks to set up two-factor " +
                "auth, then interrupts the bot's walk-through mid-reply to switch " +
                "to a password reset (barge-in #1, unrolled agent({ wait: false }) " +
                "+ user), then interrupts again to ask for a brief answer (barge-in " +
                "#2, scenario.interrupt() sugar). The bot must recover both times " +
                "and follow the user's pivots rather than answering a stale topic.",
              agents: [
                scenario.pipecatAgent({
                  url: BOT_WS_URL,
                  audioFormat: "mulaw",
                  sampleRate: 8000,
                }),
                scenario.userSimulatorAgent({ voice: "openai/nova" }),
                scenario.judgeAgent({
                  // PROMISE-ENCODING criteria — the CONVERSATIONAL half of the
                  // promise (what the judge can read from the transcript): a
                  // hollow demo where the agent repeats a canned greeting or
                  // ignores the user's correction FAILS these. The AUDIO half of
                  // the promise — that a reply was actually CUT OFF (truncated
                  // segment, shorter than the full reply, barge-in fired after
                  // speech) — is asserted in CODE in the And step below, because
                  // the back-filled STT transcript of a cut-off segment still
                  // reads as a grammatical phrase (the judge cannot see the
                  // truncation from text; the recording's transcriptTruncated
                  // flag + segment durations can). The bundled bot is
                  // OpenAI-LLM-backed (real replies to the user's request) and
                  // honours barge-in, so a real run passes.
                  criteria: [
                    "The agent OPENED with a greeting on connect, THEN engaged the user's SPECIFIC requests as the conversation evolved — first the two-factor-authentication setup, then the mid-reply switch to a password reset, then keeping the answer brief",
                    "The agent did NOT ignore the user or answer a DIFFERENT question than the one asked — it followed the user's pivot from 2FA to the password reset rather than continuing on the abandoned topic",
                    "The agent recovered gracefully from BOTH interruptions — it kept responding rather than going silent after each barge-in",
                    "The conversation is a coherent multi-turn example of the interruption-recovery flow",
                  ],
                }),
              ],
              // GREET-FIRST, MULTI-TURN, with TWO barge-ins that each cut off a
              // SUBSTANTIVE reply (NOT the connect greeting):
              //  - The bundled bot emits a canned greeting the instant the
              //    socket connects (bot.py sends it on the `connected` event).
              //    So the conversation MUST open with scenario.agent() to
              //    capture that greeting as its own turn — otherwise the
              //    greeting collides with the user's opener and the first
              //    barge-in lands on the GREETING instead of a real answer,
              //    and the bot ends up answering a stale topic (issue caught
              //    by listening to the recording). agent-first mirrors the
              //    other connect-greeting demos (angry_customer / basic_greeting
              //    / random_interruptions all start with scenario.agent()).
              //  Barge-in #1 — unrolled: agent({wait:false}) starts a multi-step
              //  2FA walk-through, user() overlaps it mid-reply (executor fires
              //  the barge-in), agent() recovers onto the password-reset pivot.
              //  Barge-in #2 — sugar: interrupt() cuts the reset reply mid-stream
              //  in one step; agent() recovers brief.
              script: [
                scenario.agent(),                                   // bot greets on connect
                scenario.user("I'm trying to turn on two-factor authentication but I'm stuck — can you walk me through it?"),
                scenario.agent({ wait: false }),                    // bot starts a multi-step reply
                scenario.user("Actually — hold on, can you just reset my password instead?"),  // barge-in #1 mid-reply
                scenario.agent(),                                   // recover → password reset
                scenario.user("Perfect. How long does the reset email take?"),
                scenario.interrupt({ content: "Sorry — keep it short, I'm in a rush", waitForSpeechTimeout: 25 }),  // barge-in #2 mid-reply
                scenario.agent(),                                   // recover brief
                scenario.judge(),
              ],
              maxTurns: 12,
            });
            // Two barge-ins + recovery turns make this a long (~50s) multi-turn
            // conversation; downsample the committed full.wav to 8kHz so it
            // stays under the 1MB commit cap (Python-parity policy). Duration —
            // and thus the M1 manifest invariant — is unchanged.
            recordingDir = saveDemoRecording(result.audio, "interruption_recovery", {
              downsampleHz: 8000,
            });
          },
        );

        Then("the agent recovered and the conversation is multi-turn", () => {
          // The LOAD-BEARING proof is that the barge-in fired and the agent kept
          // going (it produced recovery audio after the interrupt) — asserted in
          // the And step. The judge is a HARD GATE: an incoherent run (agent
          // repeats a canned greeting, ignores the user's pivot, or answers a
          // stale topic) must FAIL the test, not just look hollow. Mirror:
          // angry_customer.test.ts line expect(result!.success).toBe(true).
          expect(result, "scenario.run() returned no result").not.toBeNull();
          expect(result!.audio, "result.audio missing").toBeDefined();
          expect(
            result!.audio!.segments.length,
            "expected a multi-turn recording",
          ).toBeGreaterThanOrEqual(4);
          expect(
            result!.success,
            "judge returned success=false — the agent failed the conversational criteria (greet → 2FA → cut off → password reset → cut off → brief). Listen to the recording to see what went wrong.",
          ).toBe(true);
        });

        And("the agent reply was actually cut off and then recovered", () => {
          // THE flagship capability, asserted in CODE (not just the judge): a
          // barge-in fired, the in-flight agent segment was marked truncated
          // (the reply was actually cut off — a hollow demo where the agent
          // finished speaking cannot produce this), and the agent then recovered
          // with more audio after the interrupt.
          const interruptEvents = (result!.timeline ?? []).filter(
            (e) => e.type === "user_interrupt",
          );
          expect(
            interruptEvents.length,
            "no user_interrupt event in the timeline — barge-in never fired",
          ).toBeGreaterThan(0);

          // At least one barge-in landed mid-utterance (after the agent began
          // speaking), so the interrupt was real, not fired into silence.
          const firedAfterSpeech = interruptEvents.some(
            (e) => e.metadata?.outcome === "fired_after_speech",
          );
          expect(
            firedAfterSpeech,
            "every barge-in fired BEFORE the agent spoke — nothing was cut off (cosmetic interrupt)",
          ).toBe(true);

          // The cut-off agent segment is flagged truncated AND is markedly
          // shorter than the longest (uninterrupted) agent reply — concrete
          // evidence the reply was cut short, not delivered in full.
          const agentSegs = result!.audio!.segments.filter((s) => s.speaker === "agent");
          const truncated = agentSegs.filter((s) => s.transcriptTruncated);
          expect(
            truncated.length,
            "no agent segment marked transcriptTruncated — the interrupt did not cut off a reply",
          ).toBeGreaterThan(0);
          const maxAgentDur = Math.max(
            ...agentSegs.map((s) => s.endTime - s.startTime),
          );
          const minTruncatedDur = Math.min(
            ...truncated.map((s) => s.endTime - s.startTime),
          );
          // The cut-off reply must be MEANINGFULLY shorter than the full
          // (uninterrupted) reply, not just any epsilon shorter — a ratio so a
          // near-full segment that happens to be 1ms shorter does NOT pass as a
          // "truncation" (review T4: `< maxAgentDur` alone is trivially true).
          const TRUNCATION_RATIO_MAX = 0.8;
          expect(
            minTruncatedDur / maxAgentDur,
            `the 'truncated' reply (${minTruncatedDur.toFixed(2)}s) is not ` +
              `meaningfully shorter than the full reply (${maxAgentDur.toFixed(2)}s) — ` +
              `cut-off not demonstrated`,
          ).toBeLessThan(TRUNCATION_RATIO_MAX);

          // Agent audio strictly AFTER the last interrupt = the recovery turn.
          // Both the interrupt time and the segment start are now on the SAME
          // byte-accurate audio cursor (review BLOCKER fix), so this is a
          // like-for-like comparison rather than the cross-clock guess the old
          // 10ms tolerance papered over (review T5). The comparison is STRICTLY
          // `>`: the cut-off segment itself starts at/before the interrupt cursor
          // (inclusive containment), so a non-strict check would let the
          // truncated reply masquerade as recovery audio. The real recovery
          // segment is laid after the barge-in user segment, so its start sits
          // strictly past the interrupt cursor.
          const lastInterrupt = Math.max(...interruptEvents.map((e) => e.time));
          const recoveryAgentAudio = agentSegs.some(
            (s) => s.startTime > lastInterrupt,
          );
          expect(
            recoveryAgentAudio,
            "no agent audio after the interrupt cursor — the agent did not recover",
          ).toBe(true);
          expect(recordingDir, "recording was not written").not.toBeNull();
          const irt = result!.latency?.interruptResponseTime;
          console.log(
            `[demo] interruption_recovery → ${recordingDir} ` +
              `(interrupts=${interruptEvents.length}, truncated=${truncated.length}, ` +
              `interruptResponseTime=${irt}, segments=${result!.audio?.segments.length}, ` +
              `success=${result!.success})`,
          );
        });
      },
    );
  },
  { includeTags: ["ts-interruption-recovery-demo"] },
);
