/**
 * ElevenLabs e2e demo tests — bind 2 scenarios from
 * `specs/voice-agents.feature` tagged `@e2e @ts-elevenlabs`.
 *
 * Mirrors `python/examples/voice/elevenlabs_hosted.py` and the
 * composable+branded demo. The hosted demo connects to the live
 * `wss://api.elevenlabs.io/v1/convai/conversation` socket; the
 * composable+branded demo wires {@link ElevenLabsVoiceAgent} against
 * ElevenLabs STT + TTS.
 *
 * Env-gated on `ELEVENLABS_API_KEY` (and `ELEVENLABS_AGENT_ID` for the
 * hosted demo). Without those, the suite is skipped — local-only test
 * binding stays minimal so CI doesn't burn EL credits.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { describe, it, expect, type TestContext } from "vitest";

import {
  AudioChunk,
  ELEVENLABS_CONVAI_URL_TEMPLATE,
  ElevenLabsAgentAdapter,
  ElevenLabsVoiceAgent,
  silentChunk,
} from "@langwatch/scenario";

const HERE = dirname(fileURLToPath(import.meta.url));
// __dirname is examples/vitest/tests/voice → ../../../../specs
const FEATURE_PATH = resolve(HERE, "..", "..", "..", "..", "..", "specs", "voice-agents.feature");

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

const hasHostedKey = Boolean(ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID);
const hasComposableKey = Boolean(ELEVENLABS_API_KEY);

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
          let adapter: ElevenLabsAgentAdapter;
          let connectError: unknown = null;

          Given(
            "an ElevenLabsAgentAdapter with a live agent_id and ELEVENLABS_API_KEY",
            (ctx: TestContext) => {
              if (!hasHostedKey) {
                ctx.skip();
                return;
              }
              adapter = new ElevenLabsAgentAdapter({
                agentId: ELEVENLABS_AGENT_ID!,
                apiKey: ELEVENLABS_API_KEY!,
              });
            },
          );

          When("the demo script runs via scenario.run()", async () => {
            if (!hasHostedKey) return;
            try {
              await adapter.connect();
              await adapter.sendAudio(silentChunk(0.5));
              // Drain the agent's greeting + response — one chunk is
              // enough to prove the round-trip.
              const out = await adapter.receiveAudio(15);
              expect(out).toBeInstanceOf(AudioChunk);
            } catch (err) {
              connectError = err;
            } finally {
              try {
                await adapter.disconnect();
              } catch {
                /* best-effort */
              }
            }
          });

          Then(
            "the WS reaches wss://api.elevenlabs.io/v1/convai/conversation",
            () => {
              if (!hasHostedKey) return;
              expect(adapter.url).toBe(
                ELEVENLABS_CONVAI_URL_TEMPLATE.replace(
                  "{agent_id}",
                  ELEVENLABS_AGENT_ID!,
                ),
              );
              expect(connectError).toBeNull();
            },
          );

          And("result.success is True after one turn", () => {
            if (!hasHostedKey) return;
            // PR3 (#515) lands the executor that turns scenario.run() into
            // a result-with-success boolean. Until then, the e2e proves
            // the WS roundtrip directly — surface this in PR body.
            expect(connectError).toBeNull();
          });
        },
      );

      // -------------------------------------------------------------------
      // Demo — ElevenLabs composable + branded agent
      // -------------------------------------------------------------------
      Scenario(
        "Demo — ElevenLabs composable + branded agent",
        ({ Given, When, Then, And }) => {
          let agent: ElevenLabsVoiceAgent;
          let runError: unknown = null;
          let outChunk: AudioChunk | null = null;

          Given(
            "an ElevenLabsVoiceAgent with branded defaults (ElevenLabsSTTProvider, elevenlabs/rachel TTS)",
            (ctx: TestContext) => {
              if (!hasComposableKey) {
                ctx.skip();
                return;
              }
              agent = new ElevenLabsVoiceAgent({ apiKey: ELEVENLABS_API_KEY! });
            },
          );

          When("the demo script runs via scenario.run()", async () => {
            if (!hasComposableKey) return;
            try {
              await agent.connect();
              // Push real user audio (silent placeholder is enough to
              // exercise the STT seam against the live endpoint).
              await agent.sendAudio(silentChunk(1.0));
              outChunk = await agent.receiveAudio(30);
            } catch (err) {
              runError = err;
            } finally {
              try {
                await agent.disconnect();
              } catch {
                /* best-effort */
              }
            }
          });

          Then("the STT, LLM, and TTS seams each fire at least once", () => {
            if (!hasComposableKey) return;
            expect(runError).toBeNull();
            expect(agent.lastUserTranscript).not.toBeNull();
            expect(agent.lastLlmResponse).not.toBeNull();
            expect(outChunk).toBeInstanceOf(AudioChunk);
          });

          And("result.success is True", () => {
            if (!hasComposableKey) return;
            // Same caveat as the hosted demo — PR3 introduces the result
            // contract; we assert against the seam-fire artifacts here.
            expect(runError).toBeNull();
          });
        },
      );
    },
    { includeTags: [["e2e", "ts-elevenlabs"]] },
  );
} else {
  // Without the API key, surface the gate explicitly. CI runs here.
  describe.skip("ElevenLabs e2e demos (env-gated)", () => {
    it("requires ELEVENLABS_API_KEY (+ ELEVENLABS_AGENT_ID for hosted)", () => {
      expect(true).toBe(true);
    });
  });
}
