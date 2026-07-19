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
 * `javascript/examples/vitest/outputs/recordings/elevenlabs_hosted/` and `…/elevenlabs_branded/`.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import scenario, { voice, type ScenarioResult } from "@langwatch/scenario";
import { describe, it, expect, type TestContext } from "vitest";

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
              //
              // MULTI-TURN (≥2 scripted exchanges) over the LIVE hosted ConvAI
              // socket — un-gated by #567. The adapter now commits each user turn
              // with an explicit `user_message` event instead of leaning on
              // mic-style server VAD, so a scripted 2nd user turn after the agent
              // has already replied reliably re-engages the next agent response
              // (the old single-exchange limit + `receiveAudio timed out` are
              // fixed). This is the load-bearing live proof for #567.
              script: [
                scenario.agent(),
                scenario.user("Hello, I have a question about my account."),
                scenario.agent(),
                scenario.user("Thanks. Can you tell me your support hours?"),
                scenario.agent(),
                scenario.judge(),
              ],
              maxTurns: 8,
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

          And("result.success is True after ≥2 exchanges", () => {
            if (!hasHostedKey) return;
            expect(recordingDir, "recording was not written").not.toBeNull();
            console.log(
              `[demo] elevenlabs_hosted → ${recordingDir} ` +
                `(success=${result!.success}, ${result!.audio!.segments.length} segments)`,
            );
            // #567: the explicit user_message turn-commit re-engages the agent
            // on the scripted 2nd user turn, so the live socket now carries
            // greeting + user1 + agent1 + user2 + agent2 = 5 segments. Assert
            // the full 5-segment shape — the pre-fix silence path stalls on
            // user2 and produces at most 4 segments before the timeout, so ≥5
            // is the falsifying floor that separates fixed from broken.
            expect(
              result!.audio!.segments.length,
              "expected ≥5 audio segments (greeting + user1 + agent1 + user2 + agent2) — " +
                "the pre-fix silence path stalls on user2 and cannot produce 5",
            ).toBeGreaterThanOrEqual(5);
            // The judge verdict is informative; surface success for the reviewer.
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
            // Keep replies short so a two-exchange conversation's full.wav stays
            // under the 1MB commit cap at 24kHz (a verbose agent reply pushed it
            // over; one-sentence replies keep the core demo committable WITH its
            // per-turn segments, mirroring the Python branded recording).
            agent = new ElevenLabsVoiceAgent({
              apiKey: ELEVENLABS_API_KEY!,
              systemPrompt:
                "You are a friendly support agent. Keep every reply to ONE short " +
                "sentence (under 15 words).",
            });
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
                    "The agent responded naturally across both turns",
                    "The user simulator delivered audio and the agent responded with audio",
                    "The conversation is a coherent multi-turn ElevenLabs composable + branded exchange",
                  ],
                }),
              ],
              // Composable agent: no hosted greeting on connect — start with
              // user(). MULTI-TURN: THREE full user↔agent exchanges (≥3 is the
              // real-audio multi-turn bar, D1/AC3).
              script: [
                scenario.user("Hi there, I have a quick question about my plan."),
                scenario.agent(),
                scenario.user("Got it — can I switch to an annual plan?"),
                scenario.agent(),
                scenario.user("Thanks — would my price change right away?"),
                scenario.agent(),
                scenario.judge(),
              ],
              maxTurns: 10,
            });
            // Downsample the committed full.wav to 16kHz: a 3-exchange 24kHz
            // mix sits at the 1MB per-file commit cap (duration / M1 invariant
            // unchanged — only fidelity drops).
            recordingDir = saveDemoRecording(result.audio, "elevenlabs_branded", {
              downsampleHz: 16000,
            });
          });

          Then("the STT, LLM, and TTS seams each fire at least once", () => {
            if (!hasComposableKey) return;
            expect(result, "scenario.run() returned no result").not.toBeNull();
            // The composable seams fired: a user transcript (ElevenLabs STT —
            // audio-derived), an LLM response, and synthesized agent audio (TTS).
            expect(agent!.lastUserTranscript, "STT seam did not fire").not.toBeNull();
            expect(
              (agent!.lastUserTranscript ?? "").trim().length,
              "ElevenLabs STT produced an empty user transcript (not audio-derived)",
            ).toBeGreaterThan(0);
            expect(agent!.lastLlmResponse, "LLM seam did not fire").not.toBeNull();
          });

          And("result.success is True", async () => {
            if (!hasComposableKey) return;
            expect(recordingDir, "recording was not written").not.toBeNull();
            // ≥3-exchange real-audio bar (D1/AC3): replaces the old weak
            // segments>0 floor with three user + three agent audio segments.
            const userSegs = result!.audio!.segments.filter((s) => s.speaker === "user");
            const agentSegs = result!.audio!.segments.filter((s) => s.speaker === "agent");
            expect(userSegs.length, "expected ≥3 user audio turns").toBeGreaterThanOrEqual(3);
            expect(agentSegs.length, "expected ≥3 agent audio turns").toBeGreaterThanOrEqual(3);
            for (const s of userSegs) {
              expect(s.audio.length, "a user turn carried no audio").toBeGreaterThan(0);
            }
            // Audio-DERIVED transcript proof: force STT over the recorded user
            // bytes (onlyMissing:false) and require non-empty speech per turn.
            // Clear any transcript carried over from the live run: a forced
            // re-run leaves a stale transcript in place if STT throws (a
            // transient outage), so without this the check below could green
            // on old text instead of the freshly audio-derived transcript.
            for (const s of userSegs) s.transcript = undefined;
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
            const roles = (result!.messages ?? []).map((m) => m.role);
            console.log(
              `[demo] elevenlabs_branded → ${recordingDir} ` +
                `(success=${result!.success}, segments=${result!.audio!.segments.length} ` +
                `[${userSegs.length}u/${agentSegs.length}a], roles=${roles.join(",")}) ` +
                `lastUserTranscript=${JSON.stringify(agent!.lastUserTranscript)} ` +
                `user_transcripts=${JSON.stringify(userSegs.map((s) => s.transcript))}`,
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
