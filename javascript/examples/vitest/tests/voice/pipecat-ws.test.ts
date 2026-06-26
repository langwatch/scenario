/**
 * E2E demo — Pipecat WebSocket adapter happy path.
 *
 * `scenario.pipecatAgent({ url })` (PRD §9 factory) connects to a live Pipecat
 * bot over the Twilio Media Streams protocol (mulaw/8000) and runs a full
 * `scenario.run()` with a voice userSimulatorAgent + judgeAgent. Mirrors
 * `python/examples/voice/pipecat_ws.py` (which delegates to pipecat_scenario).
 *
 * The bot must be running at PIPECAT_BOT_URL (default ws://localhost:8765/stream).
 * Bring it up with `make voice-pipecat-up` (exports OPENAI_API_KEY first — see
 * the demo recipe). Recording lands in `javascript/examples/vitest/outputs/recordings/pipecat_ws/`.
 *
 * Binds `@e2e @ts-pipecat-demo`. Env-gated on `OPENAI_API_KEY` AND a reachable
 * bot socket (`SCENARIO_PIPECAT_BOT_UP=1`, set by the runner once the bot is up).
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
// Gate on an explicit "bot is up" flag the runner sets — the bot is an
// external process (make voice-pipecat-up), not something this test spawns.
const botUp = process.env.SCENARIO_PIPECAT_BOT_UP === "1";
const RUN_E2E = hasOpenAI && botUp;

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    const Bind = RUN_E2E ? Scenario : Scenario.skip;

    Bind(
      "Demo — Pipecat WebSocket adapter happy path",
      ({ Given, When, Then, And }) => {
        let result: ScenarioResult | null = null;
        let recordingDir: string | null = null;

        Given(
          "a local Pipecat bot on ws://localhost:8765/ws and a PipecatAgentAdapter",
          () => {
            expect(RUN_E2E).toBe(true);
          },
        );

        When("the demo script runs via scenario.run()", async () => {
          result = await scenario.run({
            name: "pipecat_twilio_smoke",
            description:
              "A caller rings the phone bot. The bot greets them and answers a " +
              "brief question. The scenario records the conversation and judges " +
              "whether the bot was friendly and informative.",
            agents: [
              scenario.pipecatAgent({
                url: BOT_WS_URL,
                audioFormat: "mulaw",
                sampleRate: 8000,
              }),
              scenario.userSimulatorAgent({ voice: "openai/nova" }),
              scenario.judgeAgent({
                criteria: [
                  // Criteria are scoped to what the bundled STUB bot delivers: a
                  // live multi-turn audio exchange over the Pipecat WS. The stub
                  // is LLM-backed but has no domain knowledge, so we judge
                  // turn-taking + tone, not factual recall.
                  "The agent and user exchanged multiple audio turns over the live Pipecat WebSocket",
                  "The bot stayed engaged across the conversation and responded each time the user spoke",
                  "The conversation is a coherent multi-turn example of a Pipecat-driven voice scenario",
                ],
              }),
            ],
            // Explicit turn-taking — user speaks first to avoid a both-sides-
            // waiting deadlock against the simple stub bot. MULTI-TURN: two
            // full user↔agent exchanges over the live Pipecat WebSocket. Both
            // user turns are open-ended so the stub bot (no domain knowledge)
            // can stay conversational without being judged on facts it lacks.
            script: [
              scenario.user("Hi! I'd love some help today."),
              scenario.agent(),
              scenario.user("Great — can you tell me a little about what you can do?"),
              scenario.agent(),
              scenario.user("Nice — and what else can you help me with?"),
              scenario.agent(),
              scenario.judge(),
            ],
            maxTurns: 8,
          });
          // 8kHz is the native phone-transport rate (mulaw/8000) and keeps the
          // committed full.wav under the 1MB cap for a multi-turn conversation.
          recordingDir = saveDemoRecording(result.audio, "pipecat_ws", {
            downsampleHz: 8000,
          });
        });

        Then("result.success is True", () => {
          expect(result, "scenario.run() returned no result").not.toBeNull();
          expect(result!.success, `judge verdict: ${result!.reasoning}`).toBe(true);
        });

        And("the recording contains both user-sim and agent audio", async () => {
          expect(result!.audio, "result.audio missing").toBeDefined();
          const userSegs = result!.audio!.segments.filter((s) => s.speaker === "user");
          const agentSegs = result!.audio!.segments.filter((s) => s.speaker === "agent");
          // ≥3-exchange real-audio bar (D1/AC3) over the live Pipecat WS.
          expect(userSegs.length, "expected ≥3 user audio turns").toBeGreaterThanOrEqual(3);
          expect(agentSegs.length, "expected ≥3 agent audio turns").toBeGreaterThanOrEqual(3);
          for (const s of userSegs) {
            expect(s.audio.length, "a user turn carried no audio").toBeGreaterThan(0);
          }
          // Audio-DERIVED transcript proof: Pipecat (Twilio Media Streams)
          // carries audio only, so STT over the recorded user bytes is the only
          // source of a transcript — force it and require non-empty per turn.
          await voice.transcribeSegments(
            { segments: userSegs, timeline: [] },
            { onlyMissing: false },
          );
          for (const s of userSegs) {
            expect(
              (s.transcript ?? "").trim().length,
              "STT over a user audio turn returned empty (not audio-derived)",
            ).toBeGreaterThan(0);
          }
          expect(recordingDir, "recording was not written").not.toBeNull();
          const roles = (result!.messages ?? []).map((m) => m.role);
          console.log(
            `[demo] pipecat_ws → ${recordingDir} ` +
              `(${result!.audio!.segments.length} segments [${userSegs.length}u/${agentSegs.length}a], ` +
              `roles=${roles.join(",")}) ` +
              `user_transcripts=${JSON.stringify(userSegs.map((s) => s.transcript))}`,
          );
        });
      },
    );
  },
  { includeTags: ["ts-pipecat-demo"] },
);
