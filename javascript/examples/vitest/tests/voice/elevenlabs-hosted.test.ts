/**
 * ElevenLabs e2e demos — bind the 2 `@e2e @ts-elevenlabs` scenarios from
 * `specs/voice-agents.feature`. Real `scenario.run()`, no mocks.
 *
 * - HOSTED: `scenario.elevenLabsAgent({ agentId, apiKey })` connects to the
 *   live `wss://api.elevenlabs.io/v1/convai/conversation` socket — the hosted
 *   ConvAI agent IS the agent under test. Mirrors
 *   `python/examples/voice/elevenlabs_hosted.py` (lead with `agent()` so the
 *   greeting drains before user audio hits the wire).
 * - BRANDED: `ElevenLabsVoiceAgent` runs ElevenLabs STT + default LLM +
 *   ElevenLabs rachel TTS in-process (no socket). Mirrors
 *   `python/examples/voice/elevenlabs_branded.py`.
 *
 * Env-gated on `ELEVENLABS_API_KEY` (+ `ELEVENLABS_AGENT_ID` for hosted) and
 * `OPENAI_API_KEY` (judge LLM + user-sim TTS). Recordings land in
 * `javascript/recordings/elevenlabs_hosted/` and `…/elevenlabs_branded/`.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { describe, it, expect, type TestContext } from "vitest";
import scenario, { voice, type ScenarioResult } from "@langwatch/scenario";

import { saveDemoRecording } from "./helpers/save-demo-recording";

const { ElevenLabsVoiceAgent } = voice;

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(HERE, "..", "..", "..", "..", "..", "specs", "voice-agents.feature");

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);

const hasHostedKey = Boolean(ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID && hasOpenAI);
const hasComposableKey = Boolean(ELEVENLABS_API_KEY && hasOpenAI);

if (hasHostedKey || hasComposableKey) {
  const feature = await loadFeature(FEATURE_PATH);

  describeFeature(
    feature,
    ({ Scenario }) => {
      // -------------------------------------------------------------------
      // Demo — ElevenLabs hosted Conversational AI
      // -------------------------------------------------------------------
      Scenario(
        "Demo — ElevenLabs hosted Conversational AI",
        ({ Given, When, Then, And }) => {
          let result: ScenarioResult | null = null;
          let recordingDir: string | null = null;

          Given(
            "an ElevenLabsAgentAdapter with a live agent_id and ELEVENLABS_API_KEY",
            (ctx: TestContext) => {
              if (!hasHostedKey) ctx.skip();
            },
          );

          When("the demo script runs via scenario.run()", async () => {
            if (!hasHostedKey) return;
            result = await scenario.run({
              name: "demo_elevenlabs_hosted",
              description:
                "Happy path against a live ElevenLabs Conversational AI agent. " +
                "The greeting plays on connect (real-voice convention), the user " +
                "asks a question, the agent responds; judge evaluates naturalness.",
              agents: [
                scenario.elevenLabsAgent({
                  agentId: ELEVENLABS_AGENT_ID!,
                  apiKey: ELEVENLABS_API_KEY!,
                }),
                scenario.userSimulatorAgent({ voice: "openai/nova" }),
                scenario.judgeAgent({
                  criteria: [
                    "The agent's greeting (sent on connect) is natural and conversational",
                    "The agent and user exchanged audio turns via the live WebSocket",
                    "The conversation is a coherent example of the hosted ElevenLabs ConvAI path",
                  ],
                }),
              ],
              // Real-voice convention: EL sends first_message on connect. Lead
              // with agent() so the greeting drains before user audio hits the
              // wire (mirrors the Python twin's script).
              script: [
                scenario.agent(),
                scenario.user("Hello, I have a question about my account."),
                scenario.agent(),
                scenario.judge(),
              ],
              maxTurns: 6,
            });
            recordingDir = saveDemoRecording(result.audio, "elevenlabs_hosted");
          });

          Then(
            "the WS reaches wss://api.elevenlabs.io/v1/convai/conversation",
            () => {
              if (!hasHostedKey) return;
              expect(result, "scenario.run() returned no result").not.toBeNull();
              // The transport produced audio (at minimum the greeting):
              // result.audio is the populated recording.
              expect(result!.audio, "result.audio missing").toBeDefined();
              expect(
                result!.audio!.segments.length,
                "no audio segments captured from the live EL socket",
              ).toBeGreaterThan(0);
            },
          );

          And("result.success is True after one turn", () => {
            if (!hasHostedKey) return;
            expect(recordingDir, "recording was not written").not.toBeNull();
            // eslint-disable-next-line no-console
            console.log(
              `[demo] elevenlabs_hosted → ${recordingDir} ` +
                `(success=${result!.success}, ${result!.audio!.segments.length} segments)`,
            );
            // The judge verdict is informative but EL hosted turn-taking is
            // server-VAD-driven; the load-bearing proof is real audio over the
            // live socket. Surface success for the reviewer.
            expect(result!.success, `judge verdict: ${result!.reasoning}`).toBe(true);
          });
        },
      );

      // -------------------------------------------------------------------
      // Demo — ElevenLabs composable + branded agent
      // -------------------------------------------------------------------
      Scenario(
        "Demo — ElevenLabs composable + branded agent",
        ({ Given, When, Then, And }) => {
          let result: ScenarioResult | null = null;
          let agent: voice.ElevenLabsVoiceAgent | null = null;
          let recordingDir: string | null = null;

          Given(
            "an ElevenLabsVoiceAgent with branded defaults (ElevenLabsSTTProvider, elevenlabs/rachel TTS)",
            (ctx: TestContext) => {
              if (!hasComposableKey) ctx.skip();
            },
          );

          When("the demo script runs via scenario.run()", async () => {
            if (!hasComposableKey) return;
            agent = new ElevenLabsVoiceAgent({ apiKey: ELEVENLABS_API_KEY! });
            result = await scenario.run({
              name: "demo_elevenlabs_branded",
              description:
                "Branded ElevenLabsVoiceAgent: ElevenLabs STT + default LLM + " +
                "ElevenLabs rachel TTS. The user greets, the agent responds; judge passes.",
              agents: [
                agent,
                scenario.userSimulatorAgent({ voice: "openai/nova" }),
                scenario.judgeAgent({
                  criteria: [
                    "The agent responded naturally to the greeting",
                    "The user simulator delivered audio and the agent responded with audio",
                    "The conversation is a coherent ElevenLabs composable + branded exchange",
                  ],
                }),
              ],
              // Composable agent: no hosted greeting on connect — start with user().
              script: [
                scenario.user("Hi there, I have a quick question about my plan."),
                scenario.agent(),
                scenario.judge(),
              ],
              maxTurns: 6,
            });
            recordingDir = saveDemoRecording(result.audio, "elevenlabs_branded");
          });

          Then("the STT, LLM, and TTS seams each fire at least once", () => {
            if (!hasComposableKey) return;
            expect(result, "scenario.run() returned no result").not.toBeNull();
            // The composable seams fired: a user transcript (STT), an LLM
            // response, and synthesized agent audio (TTS) in the recording.
            expect(agent!.lastUserTranscript, "STT seam did not fire").not.toBeNull();
            expect(agent!.lastLlmResponse, "LLM seam did not fire").not.toBeNull();
            expect(
              result!.audio?.segments.length ?? 0,
              "no audio segments (TTS seam)",
            ).toBeGreaterThan(0);
          });

          And("result.success is True", () => {
            if (!hasComposableKey) return;
            expect(recordingDir, "recording was not written").not.toBeNull();
            // eslint-disable-next-line no-console
            console.log(
              `[demo] elevenlabs_branded → ${recordingDir} ` +
                `(success=${result!.success}, userTranscript=${JSON.stringify(agent!.lastUserTranscript)})`,
            );
            expect(result!.success, `judge verdict: ${result!.reasoning}`).toBe(true);
          });
        },
      );
    },
    { includeTags: [["e2e", "ts-elevenlabs"]] },
  );
} else {
  describe.skip("ElevenLabs e2e demos (env-gated)", () => {
    it("requires ELEVENLABS_API_KEY (+ ELEVENLABS_AGENT_ID for hosted) and OPENAI_API_KEY", () => {
      expect(true).toBe(true);
    });
  });
}
