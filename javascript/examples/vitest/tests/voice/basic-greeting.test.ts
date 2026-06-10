/**
 * E2E demo — basic greeting flow (§6.1), multi-turn.
 *
 * The standard pipecatAgent + voice userSimulatorAgent + judgeAgent pipeline
 * end-to-end over the live Pipecat bot: greeting → user → agent → user → agent
 * → judge (two full user↔agent exchanges after the greeting). Mirrors
 * `python/examples/voice/basic_greeting.py`.
 *
 * On success the recording lands in `javascript/examples/vitest/outputs/recordings/basic_greeting/`
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
              "help ordering pizza, the bot responds; the caller asks about " +
              "delivery time, the bot responds again. Judge: the bot greeted " +
              "naturally and engaged with the caller's SPECIFIC requests.",
            agents: [
              scenario.pipecatAgent({
                url: BOT_WS_URL,
                audioFormat: "mulaw",
                sampleRate: 8000,
              }),
              scenario.userSimulatorAgent({ voice: "openai/nova" }),
              scenario.judgeAgent({
                // PROMISE-ENCODING (mirror the Python twin + the brief): the bot
                // must ENGAGE WITH THE SPECIFIC REQUEST, not just emit a canned
                // greeting. The bundled bot is OpenAI-LLM-backed, so it engages
                // the pizza-order / delivery conversation; a hollow canned-
                // greeting bot that ignores what was asked FAILS criterion 2.
                // Scoped to "over the conversation" (not per-turn) since the stub
                // bot's STT/LLM occasionally fumbles one specific turn.
                criteria: [
                  "The agent greeted the user naturally and in a friendly tone",
                  "Over the conversation the agent ENGAGED with the caller's specific requests — the food order and/or the delivery question (e.g. asked for the delivery address, time, or order details). It did NOT merely repeat a generic canned greeting that ignores everything the caller asked.",
                  "The conversation is a coherent multi-turn greeting + help flow",
                ],
              }),
            ],
            // greeting → user → agent → user → agent → judge (multi-turn). The
            // user asks for SOMETHING SPECIFIC (pizza) so a canned-greeting bot
            // would visibly fail the "engaged with the request" criterion.
            script: [
              scenario.agent(),
              scenario.user("Hi, I'd like to order a large pepperoni pizza for delivery."),
              scenario.agent(),
              scenario.user("Great — how long will delivery take?"),
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
