/**
 * E2E demo — same `scenario.run()` entrypoint for voice and text.
 *
 * The architectural guarantee (§1 L9 — "no scenario.voice.run(), no separate
 * paradigm"): the SAME script + judge run against a text agent and a voice
 * agent through the SAME entrypoint. The text run loads no audio
 * (`result.audio` undefined); the voice run produces audio. Both succeed.
 * Mirrors `python/examples/voice/voice_text_parity.py` (self-contained:
 * OpenAI Realtime for the voice leg, no Pipecat bot).
 *
 * The voice leg's recording lands in `javascript/recordings/voice_text_parity/`.
 *
 * Binds `@e2e @ts-voice-text-parity`. Env-gated on `OPENAI_API_KEY`.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import scenario, {
  AgentAdapter,
  AgentRole,
  voice,
  type AgentInput,
  type AgentReturnTypes,
  type ScenarioResult,
} from "@langwatch/scenario";
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

// Criteria must be observable from the conversation transcript alone — the
// judge cannot inspect the runtime/entrypoint. The entrypoint-parity claim
// (§1 L9) is proven IN CODE below (same script shape + judge, text vs voice
// agent), not asserted via judge wording.
const SHARED_CRITERIA = [
  "The agent responded helpfully and on-topic to the user's greeting",
  "The agent's reply is coherent and conversational",
];

/** Minimal text-only agent that echoes a polite reply. */
class SimpleTextAgent extends AgentAdapter {
  role = AgentRole.AGENT;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return "Hi there! I'm happy to help. What do you need?";
  }
}

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    const Bind = RUN_E2E ? Scenario : Scenario.skip;

    Bind(
      "Demo — same scenario.run() entrypoint for voice and text",
      ({ Given, When, Then, And }) => {
        let textResult: ScenarioResult | null = null;
        let voiceResult: ScenarioResult | null = null;

        Given(
          "two scenarios sharing an identical script and judge, differing only in agents",
          () => {
            expect(RUN_E2E).toBe(true);
          },
        );

        When("both are executed via scenario.run()", async () => {
          // Text leg — no voice adapters, no TTS, no audio.
          textResult = await scenario.run({
            name: "parity_text",
            description: "Text-only control: same script and judge, no voice.",
            agents: [
              new SimpleTextAgent(),
              scenario.userSimulatorAgent(), // no voice → text only
              scenario.judgeAgent({ criteria: SHARED_CRITERIA }),
            ],
            script: [
              scenario.user("Hello, can you help me?"),
              scenario.agent(),
              scenario.judge(),
            ],
            maxTurns: 4,
          });

          // Voice leg — SAME entrypoint, SAME script shape, voice agent swapped in.
          voiceResult = await scenario.run({
            name: "parity_voice",
            description:
              "Voice path: OpenAI Realtime agent + voice UserSimulator, same judge.",
            agents: [
              scenario.openAIRealtimeAgent({
                model: OPENAI_REALTIME_MODEL,
                voice: "alloy",
                instructions: "You are a helpful assistant. Keep responses brief.",
                role: AgentRole.AGENT,
              }),
              scenario.userSimulatorAgent({ voice: "openai/nova" }),
              scenario.judgeAgent({ criteria: SHARED_CRITERIA }),
            ],
            script: [
              scenario.user("Hello, can you help me?"),
              scenario.agent(),
              scenario.judge(),
            ],
            maxTurns: 4,
          });
          saveDemoRecording(voiceResult.audio, "voice_text_parity");
        });

        Then("both result.success are True", () => {
          expect(textResult, "text run returned no result").not.toBeNull();
          expect(voiceResult, "voice run returned no result").not.toBeNull();
          expect(
            textResult!.success,
            `text verdict: ${textResult!.reasoning}`,
          ).toBe(true);
          expect(
            voiceResult!.success,
            `voice verdict: ${voiceResult!.reasoning}`,
          ).toBe(true);
        });

        And("no voice imports are loaded in the text-only run", () => {
          // The text run carries no audio — result.audio is undefined (voice
          // fields only populate when a VoiceAgentAdapter participates).
          expect(
            textResult!.audio,
            "text-only run unexpectedly produced audio",
          ).toBeUndefined();
          // The voice run DID produce audio — the contrast proves parity.
          expect(voiceResult!.audio?.segments.length ?? 0).toBeGreaterThan(0);
          // eslint-disable-next-line no-console
          console.log(
            `[demo] voice_text_parity → text(audio=${textResult!.audio}) ` +
              `voice(segments=${voiceResult!.audio!.segments.length})`,
          );
        });
      },
    );
  },
  { includeTags: ["ts-voice-text-parity"] },
);
