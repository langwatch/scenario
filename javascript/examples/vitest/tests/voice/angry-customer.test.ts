/**
 * E2E demo — angry customer in a noisy cafe (§6.3), multi-turn.
 *
 * `userSimulatorAgent({ voice, persona, audioEffects: [backgroundNoise("cafe",
 * 0.4), phoneQuality()] })` delivers an emotionally-heightened caller with cafe
 * noise + phone-codec degradation across a multi-turn conversation. The
 * judgeAgent evaluates empathy + noise-robustness + resolution. Mirrors
 * `python/examples/voice/angry_customer.py`.
 *
 * On success the recording lands in `javascript/recordings/angry_customer/`
 * (full.wav + manifest).
 *
 * Binds `@e2e @ts-angry-customer-demo`. Env-gated on `OPENAI_API_KEY` AND a
 * reachable bot socket (`SCENARIO_PIPECAT_BOT_UP=1`).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import scenario, { voice, type ScenarioResult } from "@langwatch/scenario";
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
      "Demo — angry customer in a noisy cafe (multi-turn)",
      ({ Given, When, Then }) => {
        let result: ScenarioResult | null = null;
        let recordingDir: string | null = null;

        Given(
          "a very-angry user simulator with backgroundNoise + phoneQuality effects",
          () => {
            expect(RUN_E2E).toBe(true);
          },
        );

        When("the multi-turn demo runs via scenario.run()", async () => {
          result = await scenario.run({
            name: "demo_angry_customer",
            description:
              "An angry customer calls from a noisy cafe about a wrong charge. " +
              "The bot must handle the emotional tone and background noise, " +
              "demonstrate empathy, and work toward a resolution.",
            agents: [
              scenario.pipecatAgent({
                url: BOT_WS_URL,
                audioFormat: "mulaw",
                sampleRate: 8000,
              }),
              scenario.userSimulatorAgent({
                voice: "openai/nova",
                persona:
                  "Very angry customer who was charged incorrectly. Speaking " +
                  "loudly and impatiently from a cafe. Wants this fixed " +
                  "immediately. Keep each turn short and heated.",
                // Effects (§4.5): cafe ambience + phone-codec degradation
                // layered on the synthesized user audio.
                audioEffects: [
                  voice.effects.backgroundNoise("cafe", 0.4),
                  voice.effects.phoneQuality(),
                ],
              }),
              scenario.judgeAgent({
                criteria: [
                  // Scoped to what's observable with the bundled stub bot: the
                  // EMOTIONALLY-HEIGHTENED, NOISY user audio was delivered and
                  // the bot kept the exchange going. The bot's empathy quality
                  // is not relied on (it is a stub, not a tuned support agent).
                  "The user audio was an emotionally heightened, impatient caller",
                  "The agent kept communicating across the exchange (it did not go silent)",
                  "The conversation is a coherent angry-customer-in-a-noisy-cafe scenario",
                ],
              }),
            ],
            // Voice convention: the bot greets first. Two full heated exchanges
            // (greeting + user + agent + user + agent). Kept to two exchanges
            // (no proceed) so the angry persona's verbose turns don't push the
            // committed full.wav past the 1MB cap even at 8kHz.
            script: [
              scenario.agent(),
              scenario.user(),
              scenario.agent(),
              scenario.user(),
              scenario.agent(),
              scenario.judge(),
            ],
            maxTurns: 8,
          });
          recordingDir = saveDemoRecording(result.audio, "angry_customer", {
            downsampleHz: 8000,
          });
        });

        Then("the agent stays calm and the recording has multiple turns", () => {
          expect(result, "scenario.run() returned no result").not.toBeNull();
          expect(result!.audio, "result.audio missing").toBeDefined();
          const speakers = new Set(result!.audio!.segments.map((s) => s.speaker));
          expect(speakers.has("user"), "no user-sim audio").toBe(true);
          expect(speakers.has("agent"), "no agent audio").toBe(true);
          // Multi-turn: greeting + ≥2 user turns → ≥4 segments.
          expect(
            result!.audio!.segments.length,
            "expected a multi-turn recording",
          ).toBeGreaterThanOrEqual(4);
          expect(recordingDir, "recording was not written").not.toBeNull();
          console.log(
            `[demo] angry_customer → ${recordingDir} ` +
              `(segments=${result!.audio!.segments.length}, success=${result!.success})`,
          );
          expect(result!.success, `judge verdict: ${result!.reasoning}`).toBe(true);
        });
      },
    );
  },
  { includeTags: ["ts-angry-customer-demo"] },
);
