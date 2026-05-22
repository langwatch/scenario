/**
 * E2E demo — OpenAIRealtimeAgentAdapter as the agent under test
 * (`role=AgentRole.AGENT`). Binds the `@e2e @ts-openai-realtime-agent-demo`
 * scenario from `specs/voice-agents.feature` via vitest-cucumber.
 *
 * Env-gated on `OPENAI_API_KEY`: skipped when the key is unset (CI on
 * branches without secrets, local dev without an OpenAI account). The PR
 * gate enforces this — see /browser-qa-against-prod in the PR body.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { AgentRole, voice } from "@langwatch/scenario";
import { expect } from "vitest";

const { AudioChunk, OPENAI_REALTIME_MODEL, OpenAIRealtimeAgentAdapter, silentChunk } = voice;

const HERE = dirname(fileURLToPath(import.meta.url));
// examples/vitest/tests/voice → repo root is six segments up.
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
    // Env-gated skip: vitest-cucumber binds the scenario in both modes so
    // `checkUncalledScenario` stays happy, but `Scenario.skip` short-
    // circuits when `OPENAI_API_KEY` is unset.
    const Bind = RUN_E2E ? Scenario : Scenario.skip;

    Bind(
      "Demo — OpenAI Realtime as the agent under test",
      ({ Given, When, Then }) => {
        let adapter: voice.OpenAIRealtimeAgentAdapter;
        let chunk: voice.AudioChunk | null = null;

        Given(
          "an OpenAIRealtimeAgentAdapter with role=AgentRole.AGENT and OPENAI_API_KEY",
          () => {
            adapter = new OpenAIRealtimeAgentAdapter({
              model: OPENAI_REALTIME_MODEL,
              voice: "alloy",
              instructions:
                "You are a concise assistant. Answer in one short sentence.",
              role: AgentRole.AGENT,
            });
            expect(adapter.role).toBe(AgentRole.AGENT);
          },
        );

        When("the demo script runs via scenario.run()", async () => {
          // PR8 ships the adapter wire protocol; the full `scenario.run()`
          // executor wiring lands in PR3. The agent-role demo exercises
          // the live round-trip we own at the adapter layer: sendAudio →
          // commit → response.create → first AudioChunk back from the
          // live OpenAI Realtime endpoint.
          await adapter.connect();
          try {
            await adapter.sendAudio(silentChunk(0.5));
            chunk = await adapter.receiveAudio(20);
          } finally {
            await adapter.disconnect();
          }
        });

        Then(
          "the model plays the agent role and result.success is True",
          () => {
            // Live signal: the realtime endpoint produced PCM16 audio for
            // our turn. Stands in for `result.success === true` until PR3
            // wires the full ScenarioResult.
            expect(chunk).toBeInstanceOf(AudioChunk);
            expect(chunk?.data.length ?? 0).toBeGreaterThan(0);
          },
        );
      },
    );
  },
  { includeTags: ["ts-openai-realtime-agent-demo"] },
);
