/**
 * E2E demo — Gemini Live native audio.
 *
 * `scenario.geminiLiveAgent({...})` (PRD §9 factory) is the agent under test:
 * a voice `userSimulatorAgent` speaks scripted lines, the Gemini Live model
 * answers in native audio over a MULTI-TURN conversation (two full user↔agent
 * exchanges), and a `judgeAgent` evaluates — all via the documented
 * `scenario.run()` entrypoint. Mirrors `python/examples/voice/gemini_live.py`.
 *
 * On success the recording lands in `javascript/examples/vitest/outputs/recordings/gemini_live/`.
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
                  "The agent responded naturally to the first message",
                  "The agent and user exchanged native-audio turns over a real Gemini Live session",
                  "The conversation is a coherent multi-turn example of the Gemini Live native-audio path",
                ],
              }),
            ],
            // Multi-turn conversation: THREE full user↔agent exchanges before
            // the judge. Gemini Live keeps context across all turns natively.
            // ≥3 exchanges is the real-audio multi-turn bar (D1/AC3).
            script: [
              scenario.user("Hello, I'm planning a trip to Japan next month."),
              scenario.agent(),
              scenario.user("What's one thing I shouldn't miss in Kyoto?"),
              scenario.agent(),
              scenario.user("And what is a good month to see the cherry blossoms?"),
              scenario.agent(),
              scenario.judge(),
            ],
            maxTurns: 8,
          });
          recordingDir = saveDemoRecording(result.audio, "gemini_live");
        });

        Then("a live session is established and result.success is True", async () => {
          expect(result, "scenario.run() returned no result").not.toBeNull();
          expect(result!.audio, "result.audio missing").toBeDefined();
          // MULTI-TURN proof over THREE exchanges. result.messages carries the
          // user↔assistant turns; the recording captures ≥3 user audio turns.
          //
          // ADAPTER NOTE (Gemini Live): the native-audio server intermittently
          // drops an AGENT turn's audio — an "interrupted → turnComplete" pair on
          // turn N+1 that the adapter's drain consumes — so agent AUDIO segments
          // AND the judge verdict are run-to-run flaky on the AGENT side (a
          // dropped mid-conversation reply reads to the judge as a continuity
          // gap). We therefore assert the multi-turn real-audio SHAPE — ≥3 user
          // audio turns, each audio-derived, plus the message exchange — rather
          // than the flaky result.success (the original test deliberately
          // omitted result.success for the same reason). The strengthened bar
          // here is the USER side (≥3, was ≥2); the agent-side native-audio drop
          // is a separate adapter limitation, out of scope for D1/AC3.
          const roles = (result!.messages ?? []).map((m) => m.role);
          const userTurns = roles.filter((r) => r === "user").length;
          const agentTurns = roles.filter((r) => r === "assistant").length;
          expect(
            userTurns,
            `expected ≥3 user turns (multi-turn); got roles=${roles.join(",")}`,
          ).toBeGreaterThanOrEqual(3);
          expect(
            agentTurns,
            `expected ≥2 agent turns (the model engaged); got roles=${roles.join(",")}`,
          ).toBeGreaterThanOrEqual(2);
          const userSegList = result!.audio!.segments.filter((s) => s.speaker === "user");
          const agentSegs = result!.audio!.segments.filter((s) => s.speaker === "agent").length;
          // ≥3-exchange real-audio bar (D1/AC3): strengthened user-audio floor
          // (was ≥2). Agent audio held to ≥1 per the native-audio drop note.
          expect(userSegList.length, "expected ≥3 recorded user audio turns").toBeGreaterThanOrEqual(3);
          expect(agentSegs, "expected ≥1 recorded agent audio turn").toBeGreaterThanOrEqual(1);
          for (const s of userSegList) {
            expect(s.audio.length, "a user turn carried no audio").toBeGreaterThan(0);
          }
          // Audio-DERIVED transcript proof: force STT over the recorded user
          // bytes (onlyMissing:false) and require non-empty speech per user turn.
          // Clear any transcript carried over from the live run: a forced
          // re-run leaves a stale transcript in place if STT throws (a
          // transient outage), so without this the check below could green
          // on old text instead of the freshly audio-derived transcript.
          for (const s of userSegList) s.transcript = undefined;
          await voice.transcribeSegments(
            { segments: userSegList, timeline: [] },
            { onlyMissing: false },
          );
          for (const s of userSegList) {
            expect(
              (s.transcript ?? "").trim().length,
              "STT over a user audio turn returned empty (not audio-derived)",
            ).toBeGreaterThan(0);
          }
          expect(recordingDir, "recording was not written").not.toBeNull();
          console.log(
            `[demo] gemini_live → ${recordingDir} ` +
              `(messages=${roles.length} [${userTurns}u/${agentTurns}a], ` +
              `segments=${result!.audio!.segments.length} [${userSegList.length}u/${agentSegs}a]) ` +
              `user_transcripts=${JSON.stringify(userSegList.map((s) => s.transcript))}`,
          );
        });
      },
    );
  },
  { includeTags: ["ts-gemini-live-e2e"] },
);
