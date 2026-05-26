/**
 * E2E demo — Gemini Live native audio.
 *
 * `scenario.geminiLiveAgent({...})` (PRD §9 factory) is the agent under test:
 * a voice `userSimulatorAgent` speaks a scripted line, the Gemini Live model
 * answers in native audio, and a `judgeAgent` evaluates — all via the
 * documented `scenario.run()` entrypoint. Mirrors
 * `python/examples/voice/gemini_live.py`.
 *
 * On success the recording lands in `javascript/recordings/gemini_live/`.
 *
 * Binds `@e2e @ts-gemini-live-e2e`. Env-gated on `GEMINI_API_KEY` (or
 * `GOOGLE_API_KEY`) for the live session + `OPENAI_API_KEY` for the user-sim
 * TTS and judge LLM. Skipped without them so CI stays green.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import scenario, { voice, type ScenarioResult } from "@langwatch/scenario";
import { expect } from "vitest";

import { saveDemoRecording } from "./helpers/save-demo-recording";

const { GEMINI_LIVE_MODEL } = voice;

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

const hasGemini = Boolean(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY);
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const RUN_E2E = hasGemini && hasOpenAI;

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    const Bind = RUN_E2E ? Scenario : Scenario.skip;

    Bind(
      "Demo — Gemini Live native audio",
      ({ Given, When, Then }) => {
        let result: ScenarioResult | null = null;
        let recordingDir: string | null = null;

        Given(
          'a GeminiLiveAgentAdapter with model "gemini-2.5-flash-native-audio" and GEMINI_API_KEY',
          () => {
            expect(hasGemini).toBe(true);
          },
        );

        When("the demo script runs via scenario.run()", async () => {
          result = await scenario.run({
            name: "demo_gemini_live",
            description:
              "Happy path against the Gemini 2.5 Flash native-audio model. " +
              "The user greets, Gemini responds in native audio; judge evaluates naturalness.",
            agents: [
              scenario.geminiLiveAgent({
                model: GEMINI_LIVE_MODEL,
                systemInstruction:
                  "You are a helpful assistant. Keep responses brief — one short sentence.",
              }),
              scenario.userSimulatorAgent({ voice: "openai/nova" }),
              scenario.judgeAgent({
                criteria: [
                  "The agent responded naturally to the greeting",
                  "The agent and user exchanged native-audio turns over a real Gemini Live session",
                  "The conversation is a coherent example of the Gemini Live native-audio path",
                ],
              }),
            ],
            script: [
              scenario.user("Hello, I'm planning a trip to Japan next month."),
              scenario.agent(),
              scenario.judge(),
            ],
            maxTurns: 4,
          });
          recordingDir = saveDemoRecording(result.audio, "gemini_live");
        });

        Then("a live session is established and result.success is True", () => {
          expect(result, "scenario.run() returned no result").not.toBeNull();
          expect(result!.audio, "result.audio missing").toBeDefined();
          expect(
            result!.audio!.segments.length,
            "no audio segments from the live Gemini session",
          ).toBeGreaterThan(0);
          expect(recordingDir, "recording was not written").not.toBeNull();
          console.log(
            `[demo] gemini_live → ${recordingDir} ` +
              `(success=${result!.success}, ${result!.audio!.segments.length} segments)`,
          );
          expect(result!.success, `judge verdict: ${result!.reasoning}`).toBe(true);
        });
      },
    );
  },
  { includeTags: ["ts-gemini-live-e2e"] },
);
