/**
 * E2E demo — random interruptions (§6.7), the probabilistic barge-in path.
 *
 * `userSimulatorAgent({ interruptProbability })` + `voiceProceed({ turns,
 * interruptions: InterruptionConfig({...}) })` injects barge-ins on roughly
 * `probability` of agent turns across a MULTI-TURN conversation. The executor's
 * proceed loop consumes the active InterruptionConfig and fires `user_interrupt`
 * events (sampling `delayRange` before barging in). Mirrors
 * `python/examples/voice/random_interruptions.py`.
 *
 * The agent under test is the bundled Pipecat stub bot. On success the recording
 * lands in `javascript/recordings/random_interruptions/` (full.wav + manifest).
 *
 * Binds `@e2e @ts-random-interruptions-demo`. Env-gated on `OPENAI_API_KEY`
 * AND a reachable bot socket (`SCENARIO_PIPECAT_BOT_UP=1`).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import scenario, { voice, type ScenarioResult } from "@langwatch/scenario";
import { expect } from "vitest";

import { saveDemoRecording } from "./helpers/save-demo-recording";

const { InterruptionConfig } = voice;

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
      "Demo — random interruptions via interruptProbability + voiceProceed",
      ({ Given, When, Then, And }) => {
        let result: ScenarioResult | null = null;
        let recordingDir: string | null = null;

        Given(
          "a user simulator with interruptProbability and voiceProceed({ interruptions })",
          () => {
            expect(RUN_E2E).toBe(true);
          },
        );

        When("the multi-turn demo script runs via scenario.run()", async () => {
          result = await scenario.run({
            name: "demo_random_interruptions",
            description:
              "A user simulator with a high interruption probability calls the bot " +
              "for help with their account. Over several turns most agent responses " +
              "are cut short. The bot must recover after the interruptions.",
            agents: [
              scenario.pipecatAgent({
                url: BOT_WS_URL,
                audioFormat: "mulaw",
                sampleRate: 8000,
              }),
              scenario.userSimulatorAgent({
                voice: "openai/nova",
                // 0.8 over 5 turns → P(zero interrupts) ≈ 0.03%; reliable as a
                // test. The persona pins the role so role-reversal doesn't drift
                // the simulator into assistant-flavored lines on later turns.
                interruptProbability: 0.8,
                persona:
                  "A customer calling for help with their account. Speak as a " +
                  "customer would — describe problems and ask questions, never " +
                  "offer help yourself.",
              }),
              scenario.judgeAgent({
                // CONVERSATIONAL criteria (mirror the Python twin); the AUDIO
                // proof that turns were actually CUT OFF is asserted in code in
                // the And step (truncated segments) — the judge can't see
                // truncation from a back-filled transcript.
                criteria: [
                  "The agent continued the conversation after the interruptions rather than stopping or going silent",
                  "The agent recovered context after being interrupted — it stayed on the user's account-help thread rather than restarting or ignoring it",
                  "The conversation involved multiple turns between user and agent",
                  "The conversation is a coherent example of probabilistic random interruptions",
                ],
              }),
            ],
            // Voice convention: the bot greets first on connect. The user's
            // request is turn 2; subsequent voiceProceed() turns are subject to
            // interruptProbability. voiceProceed (NOT the plain proceed) carries
            // the InterruptionConfig the executor's loop consumes.
            script: [
              scenario.agent(),
              scenario.user("I need help with my account"),
              scenario.voiceProceed({
                turns: 5,
                interruptions: new InterruptionConfig({
                  probability: 0.8,
                  delayRange: [0.5, 2.0],
                  strategy: "random_phrase",
                }),
              }),
              scenario.judge(),
            ],
            maxTurns: 14,
          });
          // Long multi-turn conversation → downsample full.wav to 8kHz for the
          // 1MB commit cap (duration / M1 unchanged).
          recordingDir = saveDemoRecording(result.audio, "random_interruptions", {
            downsampleHz: 8000,
          });
        });

        Then("at least one agent turn was actually interrupted (cut off)", () => {
          expect(result, "scenario.run() returned no result").not.toBeNull();
          const interruptEvents = (result!.timeline ?? []).filter(
            (e) => e.type === "user_interrupt",
          );
          expect(
            interruptEvents.length,
            "no user_interrupt event — probabilistic barge-in never fired",
          ).toBeGreaterThan(0);
          // The PROMISE: an agent turn was actually CUT OFF (not just an event
          // emitted). At least one agent segment is marked truncated — a hollow
          // run where the bot finished every reply cannot produce this.
          const truncated = (result!.audio?.segments ?? []).filter(
            (s) => s.speaker === "agent" && s.transcriptTruncated,
          );
          expect(
            truncated.length,
            "no agent segment marked transcriptTruncated — interruptions did not cut off any reply",
          ).toBeGreaterThan(0);
          console.log(
            `[demo] random_interruptions → ${recordingDir} ` +
              `(interrupts=${interruptEvents.length}, truncated=${truncated.length}, ` +
              `segments=${result!.audio?.segments.length}, success=${result!.success})`,
          );
        });

        And("the conversation involved multiple turns", () => {
          // Multi-turn proof. Aggressive interruptions (p=0.8) truncate agent
          // turns, so we assert on the TURN COUNT (start_speaking events), not
          // a fixed segment count: a barge-in can collapse an agent turn's
          // audio. The greeting + first user + ≥1 proceed turn give ≥3 speaking
          // starts, and at least one of them was interrupted (asserted above).
          const speakingStarts = (result!.timeline ?? []).filter(
            (e) =>
              e.type === "user_start_speaking" || e.type === "agent_start_speaking",
          ).length;
          expect(
            speakingStarts,
            `expected a multi-turn conversation (≥3 speaking turns); got ${speakingStarts}`,
          ).toBeGreaterThanOrEqual(3);
          expect(
            result!.audio?.segments.length ?? 0,
            "no audio recorded",
          ).toBeGreaterThan(0);
          expect(recordingDir, "recording was not written").not.toBeNull();
        });
      },
    );
  },
  { includeTags: ["ts-random-interruptions-demo"] },
);
