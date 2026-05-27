/**
 * E2E demo — Gemini Live interruption (server-VAD barge-in).
 *
 * `GeminiLiveAgentAdapter` advertises `capabilities.interruption=false` — the
 * Gemini Live protocol exposes no client-initiated cancel. Interruption relies
 * on Gemini's server VAD: when our user audio arrives mid-agent-utterance, the
 * server detects the overlap and the agent stops speaking. The executor's
 * `fireUserInterrupt` skips the native-cancel branch, pushes the new user audio,
 * and records a `user_interrupt` timeline event. Mirrors
 * `python/examples/voice/gemini_live_interruption.py`.
 *
 * On success the recording (full.wav + segments + manifest) lands in
 * `javascript/recordings/gemini_live_interruption/`.
 *
 * Binds `@e2e @ts-gemini-live-interruption-demo`. Env-gated on `GEMINI_API_KEY`
 * (Gemini Live + judge LLM) and `OPENAI_API_KEY` (user-sim TTS voice).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import scenario, { voice, type ScenarioResult } from "@langwatch/scenario";
import { expect } from "vitest";

const { GEMINI_LIVE_MODEL } = voice;

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

const hasGemini = Boolean(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY);
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const RUN_E2E = hasGemini && hasOpenAI;

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    const Bind = RUN_E2E ? Scenario : Scenario.skip;

    Bind(
      "Demo — Gemini Live interruption (server VAD barge-in)",
      ({ Given, When, Then }) => {
        let result: ScenarioResult | null = null;
        let recordingDir: string | null = null;

        Given("a Gemini Live agent and a mid-utterance interrupt()", () => {
          expect(RUN_E2E).toBe(true);
        });

        When("the demo script runs via scenario.run()", async () => {
          result = await scenario.run({
            name: "demo_gemini_live_interruption",
            description:
              "User interrupts a Gemini Live agent mid-utterance via " +
              "scenario.interrupt(). Gemini has no client-side cancel, so the " +
              "server's VAD must detect the overlap and cut the agent's reply.",
            agents: [
              scenario.geminiLiveAgent({
                model: GEMINI_LIVE_MODEL,
                voice: "Algieba",
                systemInstruction:
                  "You are a helpful assistant that gives long, detailed answers.",
              }),
              scenario.userSimulatorAgent({ voice: "openai/nova" }),
              scenario.judgeAgent({
                criteria: [
                  "The user simulator produced two distinct user turns, the second arriving while the agent was mid-reply",
                  "The user and agent exchanged native-audio turns over a real Gemini Live session",
                  "The conversation is a coherent example of a mid-utterance interrupt landing on Gemini Live",
                ],
              }),
            ],
            // The agent's verbosity (systemInstruction above) gives Gemini a
            // long reply to barge into; the user prompt stays SHORT so the
            // user TTS segment + full.wav stay under the 1MB commit cap. The
            // 12s wait gives Gemini's first-audio latency room before the
            // interrupt fires (mirrors the Python twin).
            script: [
              scenario.user("Tell me about your platform."),
              scenario.interrupt({
                content: "Sorry — what are your business hours?",
                waitForSpeechTimeout: 12,
              }),
              scenario.agent(),
              scenario.judge(),
            ],
            maxTurns: 8,
          });
          // Downsample full.wav to 8kHz for the 1MB cap (Gemini's detailed
          // reply makes a long conversation); duration / M1 unchanged.
          recordingDir = saveDemoRecording(result.audio, "gemini_live_interruption", {
            downsampleHz: 8000,
          });
        });

        Then(
          "a user_interrupt event is recorded and the recording has segments",
          () => {
            expect(result, "scenario.run() returned no result").not.toBeNull();
            expect(result!.audio, "result.audio missing").toBeDefined();
            expect(
              result!.audio!.segments.length,
              "no audio segments from the live Gemini session",
            ).toBeGreaterThan(0);
            const interruptEvents = (result!.timeline ?? []).filter(
              (e) => e.type === "user_interrupt",
            );
            expect(
              interruptEvents.length,
              "no user_interrupt event — the barge-in never fired on the Gemini socket",
            ).toBeGreaterThan(0);
            expect(recordingDir, "recording was not written").not.toBeNull();
            console.log(
              `[demo] gemini_live_interruption → ${recordingDir} ` +
                `(interrupts=${interruptEvents.length}, segments=${result!.audio!.segments.length}, ` +
                `success=${result!.success})`,
            );
          },
        );
      },
    );
  },
  { includeTags: ["ts-gemini-live-interruption-demo"] },
);
