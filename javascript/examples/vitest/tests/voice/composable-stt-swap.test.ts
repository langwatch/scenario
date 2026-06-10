/**
 * E2E demo — STT provider swap via `run({ voice: { stt } })` (in-process).
 *
 * The pluggable judge STT seam (ADR-002, per-run not a global): instead of the
 * default OpenAI STT, the judge transcribes the conversation's audio turns via
 * a swapped `ElevenLabsSTTProvider`, passed on the run as
 * `run({ voice: { stt } })` — the API that replaced the removed
 * `scenario.configure(stt=...)`. Mirrors `python/examples/voice/stt_swap.py`
 * but stays fully in-process: the agent under test is the self-contained
 * OpenAI Realtime model (no Pipecat bot needed).
 *
 * The swap is verified MECHANICALLY: an instrumented EL STT counts its
 * `transcribe()` calls — the judge only ever sees text, so this is the only
 * observable proof the swapped provider (not the default) ran. The demo is a
 * MULTI-TURN conversation (two full user↔agent exchanges), so the swapped STT
 * transcribes more than one agent audio turn.
 *
 * Binds `@e2e @ts-stt-swap`. Env-gated on `OPENAI_API_KEY` (Realtime agent +
 * user-sim TTS + judge LLM) and `ELEVENLABS_API_KEY` (the swapped STT).
 * Recording lands in `javascript/examples/vitest/outputs/recordings/composable_stt_swap/`.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import scenario, { AgentRole, voice, type ScenarioResult } from "@langwatch/scenario";
import { expect } from "vitest";

import { saveDemoRecording } from "./helpers/save-demo-recording";

const { OPENAI_REALTIME_MODEL, ElevenLabsSTTProvider } = voice;

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

const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const hasEleven = Boolean(process.env.ELEVENLABS_API_KEY);
const RUN_E2E = hasOpenAI && hasEleven;

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    const Bind = RUN_E2E ? Scenario : Scenario.skip;

    Bind(
      "Demo — STT provider swap via run({ voice: { stt } })",
      ({ Given, When, Then, And }) => {
        let result: ScenarioResult | null = null;
        let transcribeCalls = 0;
        let recordingDir: string | null = null;

        Given(
          "a voice scenario run with run({ voice: { stt: ElevenLabsSTTProvider(...) } })",
          () => {
            expect(RUN_E2E).toBe(true);
          },
        );

        When(
          "the demo script runs and the audio turn is auto-transcribed for the judge",
          async () => {
            // Instrument the EL STT: count transcribe() calls (the swap is only
            // observable mechanically — the judge sees text, not the provider).
            const baseStt = new ElevenLabsSTTProvider({
              apiKey: process.env.ELEVENLABS_API_KEY!,
            });
            const instrumentedStt: voice.STTProvider = {
              async transcribe(audio) {
                transcribeCalls += 1;
                return baseStt.transcribe(audio);
              },
            };

            result = await scenario.run(
              {
                name: "demo_composable_stt_swap",
                description:
                  "Swap the judge's STT to ElevenLabsSTTProvider via run({ voice: { stt } }). " +
                  "The audio turns are auto-transcribed by the swapped provider for the judge.",
                agents: [
                  scenario.openAIRealtimeAgent({
                    model: OPENAI_REALTIME_MODEL,
                    voice: "alloy",
                    instructions:
                      "You are a helpful assistant. Keep responses brief.",
                    role: AgentRole.AGENT,
                  }),
                  scenario.userSimulatorAgent({ voice: "openai/nova" }),
                  scenario.judgeAgent({
                    criteria: [
                      "The agent responded helpfully across both turns",
                      "The conversation is a coherent multi-turn voice exchange",
                    ],
                  }),
                ],
                // Multi-turn: two full user↔agent exchanges. Both agent audio
                // turns get auto-transcribed by the swapped EL STT for the
                // judge, so the swap fires more than once.
                script: [
                  scenario.user("Hello, can you help me with a quick question?"),
                  scenario.agent(),
                  scenario.user("Thanks — and what time zone are you in?"),
                  scenario.agent(),
                  scenario.judge(),
                ],
                maxTurns: 6,
              },
              // The per-run STT swap (ADR-002): seeds cfg.voice.stt, which the
              // judge resolves via resolveVoiceConfig in its STT pre-pass.
              { voice: { stt: instrumentedStt } },
            );
            recordingDir = saveDemoRecording(result.audio, "composable_stt_swap");
          },
        );

        Then(
          "the ElevenLabsSTTProvider.transcribe() path was exercised (not the default)",
          () => {
            expect(result, "scenario.run() returned no result").not.toBeNull();
            // Mechanical proof: the swapped provider transcribed ≥1 audio turn.
            expect(
              transcribeCalls,
              "the swapped ElevenLabsSTTProvider.transcribe() never ran — " +
                "the judge fell back to the default OpenAI STT",
            ).toBeGreaterThan(0);
            console.log(
              `[demo] composable_stt_swap → ${recordingDir} ` +
                `(EL STT transcribe() calls=${transcribeCalls}, success=${result!.success})`,
            );
          },
        );

        And("result.success is True", () => {
          expect(result!.success, `judge verdict: ${result!.reasoning}`).toBe(true);
        });
      },
    );
  },
  { includeTags: ["ts-stt-swap"] },
);
