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

const { OPENAI_REALTIME_MODEL, OpenAIRealtimeAgentAdapter } = voice;

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
        let connectError: unknown = null;

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
          // executor wiring (which drives real speech audio into the model)
          // lands in PR3. For the agent-role demo we exercise the
          // bidirectional wire we own: connect (GA handshake), assert
          // the WS is live (capabilities matrix is published, interrupt
          // round-trips a no-op `response.cancel`), then disconnect.
          // Pumping silent audio doesn't trigger the model with
          // `turn_detection: null` — that path is PR3's territory.
          try {
            await adapter.connect();
            await adapter.interrupt(); // round-trips response.cancel
          } catch (err) {
            connectError = err;
          } finally {
            await adapter.disconnect();
          }
        });

        Then(
          "the model plays the agent role and result.success is True",
          () => {
            // Live signal: connect handshake + session.update accepted by
            // the GA endpoint, response.cancel round-tripped without an
            // error event. Stands in for `result.success === true` until
            // PR3 wires the full ScenarioResult and the demo can drive
            // real speech audio through the executor.
            expect(connectError).toBeNull();
            expect(adapter.capabilities.streamingTranscripts).toBe(true);
            expect(adapter.capabilities.interruption).toBe(true);
          },
        );
      },
    );
  },
  { includeTags: ["ts-openai-realtime-agent-demo"] },
);
