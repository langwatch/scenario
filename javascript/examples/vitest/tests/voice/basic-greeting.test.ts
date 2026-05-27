/**
 * E2E demo — basic greeting flow (§6.1), multi-turn.
 *
 * The standard pipecatAgent + voice userSimulatorAgent + judgeAgent pipeline
 * end-to-end over the live Pipecat bot: greeting → user → agent → user → agent
 * → judge (two full user↔agent exchanges after the greeting). Mirrors
 * `python/examples/voice/basic_greeting.py`.
 *
 * On success the recording lands in `javascript/recordings/basic_greeting/`
 * (full.wav + manifest).
 *
 * Binds `@e2e @ts-basic-greeting-demo`. Env-gated on `OPENAI_API_KEY` AND a
 * reachable bot socket (`SCENARIO_PIPECAT_BOT_UP=1`).
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
      "Demo — basic greeting flow (multi-turn)",
      ({ Given, When, Then }) => {
        let result: ScenarioResult | null = null;
        let recordingDir: string | null = null;

        Given("a local Pipecat bot and a voice user simulator", () => {
          expect(RUN_E2E).toBe(true);
        });

        When("the multi-turn greeting demo runs via scenario.run()", async () => {
          result = await scenario.run({
            name: "demo_basic_greeting",
            description:
              "A caller rings the bot. The bot greets them; the caller asks for " +
              "help, the bot responds; the caller follows up, the bot responds " +
              "again. Judge: the bot greeted naturally and stayed helpful.",
            agents: [
              scenario.pipecatAgent({
                url: BOT_WS_URL,
                audioFormat: "mulaw",
                sampleRate: 8000,
              }),
              scenario.userSimulatorAgent({ voice: "openai/nova" }),
              scenario.judgeAgent({
                criteria: [
                  "The agent greeted the user and offered help in a friendly tone",
                  "The agent and user exchanged multiple real audio turns",
                  "The conversation is a coherent multi-turn greeting flow",
                ],
              }),
            ],
            // greeting → user → agent → user → agent → judge (multi-turn).
            script: [
              scenario.agent(),
              scenario.user("Hi, I need some help today."),
              scenario.agent(),
              scenario.user("Thanks — can you point me in the right direction?"),
              scenario.agent(),
              scenario.judge(),
            ],
            maxTurns: 8,
          });
          recordingDir = saveDemoRecording(result.audio, "basic_greeting", {
            downsampleHz: 8000,
          });
        });

        Then("result.success is True and the recording has both speakers", () => {
          expect(result, "scenario.run() returned no result").not.toBeNull();
          expect(result!.audio, "result.audio missing").toBeDefined();
          const speakers = new Set(result!.audio!.segments.map((s) => s.speaker));
          expect(speakers.has("user"), "no user-sim audio").toBe(true);
          expect(speakers.has("agent"), "no agent audio").toBe(true);
          // Multi-turn: greeting + two exchanges → ≥4 segments.
          expect(
            result!.audio!.segments.length,
            "expected a multi-turn recording",
          ).toBeGreaterThanOrEqual(4);
          expect(recordingDir, "recording was not written").not.toBeNull();
          console.log(
            `[demo] basic_greeting → ${recordingDir} ` +
              `(segments=${result!.audio!.segments.length}, success=${result!.success})`,
          );
          expect(result!.success, `judge verdict: ${result!.reasoning}`).toBe(true);
        });
      },
    );
  },
  { includeTags: ["ts-basic-greeting-demo"] },
);
