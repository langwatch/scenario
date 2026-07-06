/**
 * E2E demo — OpenAI Realtime as the agent under test (BASELINE).
 *
 * The model itself is the agent (`role=AgentRole.AGENT`): a voice
 * `userSimulatorAgent` speaks scripted lines (TTS → audio), the Realtime
 * model hears them and answers in audio over a MULTI-TURN conversation (two
 * full user↔agent exchanges), and a `judgeAgent` evaluates the exchange — all
 * through the documented `scenario.run()` entrypoint and the
 * `scenario.openAIRealtimeAgent({...})` factory (PRD §9). Mirrors
 * `python/examples/voice/openai_realtime_agent.py`.
 *
 * On success the recording (full.wav + segments/ + manifest.json) lands in
 * `javascript/examples/vitest/outputs/recordings/openai_realtime_agent/` via {@link saveDemoRecording}.
 *
 * Binds `@e2e @ts-openai-realtime-agent-demo` from `specs/voice-agents.feature`.
 * Env-gated on `OPENAI_API_KEY`: skipped when unset so CI without secrets
 * stays green.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import scenario, { AgentRole, voice, type ScenarioResult } from "@langwatch/scenario";
import { expect } from "vitest";

import { saveDemoRecording } from "./helpers/save-demo-recording";

const { OPENAI_REALTIME_MODEL } = voice;

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

const RUN_E2E = Boolean(process.env.OPENAI_API_KEY);

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    const Bind = RUN_E2E ? Scenario : Scenario.skip;

    Bind(
      "Demo — OpenAI Realtime as the agent under test",
      ({ Given, When, Then }) => {
        // Only the computed result crosses steps (When → Then).
        let result: ScenarioResult | null = null;

        Given(
          "an OpenAIRealtimeAgentAdapter with role=AgentRole.AGENT and OPENAI_API_KEY",
          () => {
            expect(Boolean(process.env.OPENAI_API_KEY)).toBe(true);
          },
        );

        When("the demo script runs via scenario.run()", async () => {
          result = await scenario.run({
            name: "demo_openai_realtime_agent",
            description:
              "OpenAI Realtime model plays the agent role. The user greets it; " +
              "the model responds in audio; the judge evaluates the exchange.",
            agents: [
              // The documented factory idiom (PRD §9). The model IS the agent.
              scenario.openAIRealtimeAgent({
                model: OPENAI_REALTIME_MODEL,
                voice: "alloy",
                instructions:
                  "You are a helpful assistant. Keep responses brief — one short sentence.",
                role: AgentRole.AGENT,
              }),
              // Voice user simulator: scripted text is TTS'd to audio and sent
              // into the Realtime session as the user turn.
              scenario.userSimulatorAgent({ voice: "openai/nova" }),
              scenario.judgeAgent({
                criteria: [
                  "The agent responded naturally to the user's greeting",
                  "The agent answered the follow-up question on topic",
                  "The conversation is a coherent multi-turn voice exchange",
                ],
              }),
            ],
            // Multi-turn conversation: THREE full user↔agent exchanges before
            // the judge (user → agent → user → agent → user → agent → judge).
            // The realtime model carries context across all three turns over the
            // same live session. ≥3 exchanges is the real-audio multi-turn bar
            // (D1/AC3) — each user turn is TTS'd to audio and answered live.
            script: [
              scenario.user("Hello, can you help me plan a weekend trip?"),
              scenario.agent(),
              scenario.user("Great — what should I pack for cold weather?"),
              scenario.agent(),
              scenario.user("And what is one local dish I should try there?"),
              scenario.agent(),
              scenario.judge(),
            ],
            maxTurns: 8,
          });
        });

        Then(
          "the model plays the agent role and result.success is True",
          async () => {
            expect(result, "scenario.run() returned no result").not.toBeNull();
            const r = result!;
            // The full pipeline ran: TTS → Realtime model → judge verdict.
            expect(r.success, `judge verdict: ${r.reasoning}`).toBe(true);
            // result.audio is the populated VoiceRecordingRuntime (Gap A/B):
            // user-sim + agent segments captured across all THREE exchanges.
            expect(r.audio, "result.audio missing").toBeDefined();
            const userSegs = r.audio!.segments.filter((s) => s.speaker === "user");
            const agentSegs = r.audio!.segments.filter((s) => s.speaker === "agent");
            // ≥3-exchange real-audio bar (D1/AC3): three user + three agent
            // audio segments over the one live session.
            expect(
              userSegs.length,
              `expected ≥3 user audio turns (real-audio multi-turn); got ${userSegs.length}`,
            ).toBeGreaterThanOrEqual(3);
            expect(
              agentSegs.length,
              `expected ≥3 agent audio turns (model replied to each); got ${agentSegs.length}`,
            ).toBeGreaterThanOrEqual(3);
            // Real audio every user turn: non-empty PCM16 bytes on the wire.
            for (const s of userSegs) {
              expect(s.audio.length, "a user turn carried no audio").toBeGreaterThan(0);
            }
            // Persist the listenable proof (manifest carries the back-filled,
            // STT-derived transcripts). Downsample the committed full.wav to
            // 16kHz: a 3-exchange 24kHz mix exceeds the 1MB per-file commit cap
            // (duration / M1 invariant unchanged — only fidelity drops).
            const dir = saveDemoRecording(r.audio, "openai_realtime_agent", {
              downsampleHz: 16000,
            });
            expect(dir, "recording was not written").not.toBeNull();
            // Audio-DERIVED transcript proof: force STT over the recorded user
            // bytes (onlyMissing:false overwrites any transport-supplied text),
            // then require every user turn to transcribe to non-empty speech —
            // silence or a text-only commit cannot satisfy this.
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
            const roles = (r.messages ?? []).map((m) => m.role);
            console.log(
              `[demo] openai_realtime_agent → ${dir} ` +
                `(${r.audio!.segments.length} segments [${userSegs.length}u/${agentSegs.length}a], ` +
                `${r.audio!.duration?.toFixed(2)}s, roles=${roles.join(",")}) ` +
                `user_transcripts=${JSON.stringify(userSegs.map((s) => s.transcript))}`,
            );
          },
        );
      },
    );
  },
  { includeTags: ["ts-openai-realtime-agent-demo"] },
);
