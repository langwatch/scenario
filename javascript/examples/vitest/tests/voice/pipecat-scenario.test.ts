/**
 * E2E demo — Pipecat TRANSPORT SMOKE (multi-turn).
 *
 * This is the designated TRANSPORT-SMOKE demo (issue #372 demo set): it proves
 * the PipecatAgentAdapter drives a real Twilio-Media-Streams (mulaw/8000)
 * WebSocket exchange end-to-end — connect, send audio, receive audio, record.
 * It deliberately makes NO real-conversation-quality or cut-off claim; the
 * conversational + interruption promises live in the other demos
 * (basic_greeting, interruption_recovery, random_interruptions). The bundled
 * bot IS LLM-backed, but here we only assert the TRANSPORT round-trips audio
 * both ways across multiple turns. Mirrors `python/examples/voice/pipecat_scenario.py`.
 *
 * On success the recording lands in `javascript/examples/vitest/outputs/recordings/pipecat_scenario/`
 * (full.wav + manifest).
 *
 * Binds `@e2e @ts-pipecat-scenario-demo`. Env-gated on `OPENAI_API_KEY` AND a
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
      "Demo — Pipecat scenario smoke (multi-turn)",
      ({ Given, When, Then }) => {
        let result: ScenarioResult | null = null;
        let recordingDir: string | null = null;

        Given("a local Pipecat bot on ws://localhost:8765/stream", () => {
          expect(RUN_E2E).toBe(true);
        });

        When("the multi-turn smoke demo runs via scenario.run()", async () => {
          result = await scenario.run({
            name: "pipecat_twilio_smoke",
            description:
              "A caller rings the phone bot. The bot greets them and answers a " +
              "couple of brief questions over multiple turns. Scenario records " +
              "the conversation and judges whether the bot stayed engaged.",
            agents: [
              scenario.pipecatAgent({
                url: BOT_WS_URL,
                audioFormat: "mulaw",
                sampleRate: 8000,
              }),
              scenario.userSimulatorAgent({ voice: "openai/nova" }),
              scenario.judgeAgent({
                // TRANSPORT-SMOKE criteria only: the WS round-tripped audio both
                // ways across turns and the bot stayed responsive. NO claim about
                // conversation quality / request-acknowledgement / cut-off — those
                // are the other demos' job (see file docstring).
                criteria: [
                  "The agent and user exchanged multiple audio turns over the live Pipecat WebSocket",
                  "The bot stayed responsive (it produced a reply each time the user spoke, not silence)",
                  "The conversation is a coherent multi-turn Pipecat transport smoke",
                ],
              }),
            ],
            // Explicit turn-taking — user speaks first to avoid a both-sides-
            // waiting deadlock against the stub bot. Two full exchanges.
            script: [
              scenario.user("Hi! Can you help me with a question?"),
              scenario.agent(),
              scenario.user("Thanks — what else can you do?"),
              scenario.agent(),
              scenario.judge(),
            ],
            maxTurns: 6,
          });
          recordingDir = saveDemoRecording(result.audio, "pipecat_scenario", {
            downsampleHz: 8000,
          });
        });

        Then(
          "the recording contains both user-sim and agent audio across turns",
          () => {
            expect(result, "scenario.run() returned no result").not.toBeNull();
            expect(result!.audio, "result.audio missing").toBeDefined();
            const speakers = new Set(result!.audio!.segments.map((s) => s.speaker));
            expect(speakers.has("user"), "no user-sim audio").toBe(true);
            expect(speakers.has("agent"), "no agent audio").toBe(true);
            expect(
              result!.audio!.segments.length,
              "expected a multi-turn recording",
            ).toBeGreaterThanOrEqual(4);
            expect(recordingDir, "recording was not written").not.toBeNull();
            console.log(
              `[demo] pipecat_scenario → ${recordingDir} ` +
                `(segments=${result!.audio!.segments.length}, success=${result!.success})`,
            );
          },
        );
      },
    );
  },
  { includeTags: ["ts-pipecat-scenario-demo"] },
);
