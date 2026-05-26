/**
 * E2E demo — OpenAI Realtime as the agent under test (BASELINE).
 *
 * The model itself is the agent (`role=AgentRole.AGENT`): a voice
 * `userSimulatorAgent` speaks a scripted line (TTS → audio), the Realtime
 * model hears it and answers in audio, and a `judgeAgent` evaluates the
 * exchange — all through the documented `scenario.run()` entrypoint and the
 * `scenario.openAIRealtimeAgent({...})` factory (PRD §9). Mirrors
 * `python/examples/voice/openai_realtime_agent.py`.
 *
 * On success the recording (full.wav + segments/ + manifest.json) lands in
 * `javascript/recordings/openai_realtime_agent/` via {@link saveDemoRecording}.
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
                  "The conversation is a coherent voice exchange",
                ],
              }),
            ],
            script: [
              scenario.user("Hello, can you help me?"),
              scenario.agent(),
              scenario.judge(),
            ],
            maxTurns: 4,
          });
        });

        Then(
          "the model plays the agent role and result.success is True",
          () => {
            expect(result, "scenario.run() returned no result").not.toBeNull();
            const r = result!;
            // The full pipeline ran: TTS → Realtime model → judge verdict.
            expect(r.success, `judge verdict: ${r.reasoning}`).toBe(true);
            // result.audio is the populated VoiceRecordingRuntime (Gap A/B):
            // both user-sim and agent segments captured.
            expect(r.audio, "result.audio missing").toBeDefined();
            expect(
              r.audio!.segments.length,
              "no audio segments captured",
            ).toBeGreaterThan(0);
            // Persist the listenable proof.
            const dir = saveDemoRecording(r.audio, "openai_realtime_agent");
            expect(dir, "recording was not written").not.toBeNull();
            console.log(
              `[demo] openai_realtime_agent → ${dir} ` +
                `(${r.audio!.segments.length} segments, ${r.audio!.duration?.toFixed(2)}s)`,
            );
          },
        );
      },
    );
  },
  { includeTags: ["ts-openai-realtime-agent-demo"] },
);
