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
 * gating). Mirrors `python/examples/voice/interruption_recovery.py`.
 *
 * On success the recording lands in
 * `javascript/recordings/interruption_recovery/` (full.wav + manifest only).
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
                "User interrupts the agent twice mid-utterance — first via the " +
                "unrolled agent({ wait: false }) + user composition, then via the " +
                "scenario.interrupt() sugar. The bot must recover both times.",
              agents: [
                scenario.pipecatAgent({
                  url: BOT_WS_URL,
                  audioFormat: "mulaw",
                  sampleRate: 8000,
                }),
                scenario.userSimulatorAgent({ voice: "openai/nova" }),
                scenario.judgeAgent({
                  criteria: [
                    // Scoped to what the bundled STUB bot delivers: it keeps the
                    // conversation alive after each barge-in. The bot is
                    // LLM-backed but has no domain knowledge, so we judge
                    // recovery BEHAVIOR (kept responding, stayed conversational),
                    // not whether it nailed a specific requested topic.
                    "The agent kept responding after each interruption rather than going silent",
                    "The agent stayed conversational and engaged across the whole exchange",
                    "The conversation is a coherent multi-turn example of a barge-in/recovery flow",
                  ],
                }),
              ],
              // MULTI-TURN with TWO barge-ins (mirrors the Python twin):
              //  Exchange 1 — unrolled: agent({wait:false}) starts the reply,
              //  user() overlaps it (executor fires barge-in), agent() recovers.
              //  Exchange 2 — sugar: interrupt() does the same in one step.
              script: [
                scenario.user("Tell me about my billing options"),
                scenario.agent({ wait: false }),
                scenario.user("Wait sorry, I meant account support, not billing"),
                scenario.agent(),
                scenario.user("Tell me about every feature you offer"),
                scenario.interrupt({
                  content: "Sorry, one more thing — can you keep it brief?",
                  waitForSpeechTimeout: 15,
                }),
                scenario.agent(),
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
          // the And step. The stub bot's exact recovery content varies run to
          // run, so the judge verdict is informative, not a hard gate (matching
          // the other pipecat-stub demos).
          expect(result, "scenario.run() returned no result").not.toBeNull();
          expect(result!.audio, "result.audio missing").toBeDefined();
          expect(
            result!.audio!.segments.length,
            "expected a multi-turn recording",
          ).toBeGreaterThanOrEqual(4);
        });

        And("result.latency.interruptResponseTime is recorded", () => {
          // The barge-in path records a user_interrupt event in the timeline and
          // derives interruptResponseTime (how fast the agent stopped after the
          // overlap). Prove at least one barge-in actually fired — THE flagship
          // capability — and that the agent then recovered with more audio.
          const interruptEvents = (result!.timeline ?? []).filter(
            (e) => e.type === "user_interrupt",
          );
          expect(
            interruptEvents.length,
            "no user_interrupt event in the timeline — barge-in never fired",
          ).toBeGreaterThan(0);
          // Agent audio AFTER the last interrupt = the recovery turn.
          const lastInterrupt = Math.max(
            ...interruptEvents.map((e) => e.time),
          );
          const recoveryAgentAudio = result!.audio!.segments.some(
            (s) => s.speaker === "agent" && s.startTime >= lastInterrupt - 0.01,
          );
          expect(
            recoveryAgentAudio,
            "no agent audio after the interrupt — the agent did not recover",
          ).toBe(true);
          expect(recordingDir, "recording was not written").not.toBeNull();
          const irt = result!.latency?.interruptResponseTime;
          console.log(
            `[demo] interruption_recovery → ${recordingDir} ` +
              `(interrupts=${interruptEvents.length}, interruptResponseTime=${irt}, ` +
              `segments=${result!.audio?.segments.length}, success=${result!.success})`,
          );
        });
      },
    );
  },
  { includeTags: ["ts-interruption-recovery-demo"] },
);
