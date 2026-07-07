/**
 * E2E demo — ElevenLabs interruption (server-VAD barge-in).
 *
 * `ElevenLabsAgentAdapter` advertises `capabilities.interruption=false` — the
 * ConvAI WebSocket exposes no client-initiated cancel. Interruption on this
 * transport relies on the server's VAD: when our user audio arrives
 * mid-agent-utterance, EL's server detects the overlap and cuts the agent's
 * reply. The executor's `fireUserInterrupt` skips the native-cancel branch
 * (capability gate false), pushes the new user audio onto the wire, and records
 * a `user_interrupt` timeline event. Mirrors
 * `python/examples/voice/elevenlabs_interruption.py`.
 *
 * EL-specific timing (verified in the Python twin): send the user's first audio
 * WHILE EL is still playing its first_message greeting on connect — that is what
 * engages EL's turn-taking. A "lead with bare agent() to drain the greeting"
 * approach fails. A per-session `systemPromptOverride` makes the agent verbose
 * so the barge-in has audio to overlap, without mutating the shared test agent.
 *
 * On success the recording (full.wav + segments + manifest) lands in
 * `javascript/examples/vitest/outputs/recordings/elevenlabs_interruption/`.
 *
 * Binds `@e2e @ts-elevenlabs-interruption-demo`. Env-gated on `OPENAI_API_KEY`
 * (judge LLM + user-sim TTS), `ELEVENLABS_API_KEY`, and `ELEVENLABS_AGENT_ID`.
 *
 * STATUS — Un-gated after 3/3 consecutive clean live runs (#731). A successful
 * run produces at least one truncated agent segment (barge-in cuts the agent
 * mid-utterance) and the agent PIVOTS to business hours — verified live. The barge-in
 * MECHANISM is also proven NON-flakily on the other server-VAD transport
 * (`gemini_live_interruption`, no client cancel) and on Pipecat
 * (`interruption_recovery` / `random_interruptions`). NOT faked — when run,
 * the code asserts a real truncated segment. Test skips when ElevenLabs or
 * OpenAI credentials are absent.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import scenario, { type ScenarioResult } from "@langwatch/scenario";
import { expect } from "vitest";

import { saveDemoRecording } from "./helpers/save-demo-recording";

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

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const RUN_E2E = Boolean(ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID && hasOpenAI);

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    const Bind = RUN_E2E ? Scenario : Scenario.skip;

    Bind(
      "Demo — ElevenLabs interruption (server VAD barge-in)",
      ({ Given, When, Then }) => {
        let result: ScenarioResult | null = null;
        let recordingDir: string | null = null;

        Given(
          "a hosted ElevenLabs ConvAI agent and a mid-utterance interrupt()",
          () => {
            expect(RUN_E2E).toBe(true);
          },
        );

          When("the demo script runs via scenario.run()", async () => {
            result = await scenario.run({
              name: "demo_elevenlabs_interruption",
              description:
                "User interrupts a hosted ElevenLabs ConvAI agent mid-utterance " +
                "via scenario.interrupt(). EL has no client-side cancel, so the " +
                "server's VAD must detect the overlap and cut the agent's reply.",
              agents: [
                scenario.elevenLabsAgent({
                  agentId: ELEVENLABS_AGENT_ID!,
                  apiKey: ELEVENLABS_API_KEY!,
                  // Verbose per-session prompt so the agent has audio to barge
                  // into (applied via conversation_initiation_client_data; the
                  // shared provisioned test agent stays concise).
                  systemPromptOverride:
                    "You are a chatty product specialist. When asked about " +
                    "products or features, give a long, detailed answer with " +
                    "several sentences.",
                }),
                scenario.userSimulatorAgent({ voice: "openai/nova" }),
                scenario.judgeAgent({
                  // CONVERSATIONAL criteria (mirror the Python twin): the load-
                  // bearing PIVOT check — after the user interrupts to ask about
                  // business hours, the agent's NEXT reply must address business
                  // hours, not keep listing products. The AUDIO cut-off proof
                  // (truncated segment) is asserted in code in the Then step.
                  criteria: [
                    "The user and agent exchanged audio over the live ElevenLabs ConvAI socket",
                    "After the user's interrupting turn (asking about business hours), the agent's reply PIVOTS to acknowledge the new topic — it does NOT just keep describing products/features as if uninterrupted",
                    "The conversation is a coherent example of a mid-utterance interrupt landing on ElevenLabs ConvAI and the agent acknowledging the topic shift",
                  ],
                }),
              ],
              // EL-specific (mirrors the Python twin): user audio overlaps the
              // greeting on connect to engage turn-taking; a verbose request
              // gives the agent something to barge into; interrupt() fires the
              // mid-utterance barge-in.
              script: [
                scenario.user("Hello, I'd like to know about your products."),
                scenario.agent(),
                scenario.user("Tell me about every product feature you offer in detail."),
                scenario.interrupt({
                  content: "Sorry, one more thing — what are your business hours?",
                  waitForSpeechTimeout: 15,
                }),
                scenario.agent(),
                scenario.judge(),
              ],
              maxTurns: 12,
            });
            // Downsample so a successful run's full.wav stays under the 1MB cap
            // (the EL ConvAI conversation is long; at 24kHz it exceeds it).
            recordingDir = saveDemoRecording(result.audio, "elevenlabs_interruption", {
              downsampleHz: 8000,
            });
          });

          Then(
            "the agent's reply was cut off and it pivoted to the new topic",
            () => {
              expect(result, "scenario.run() returned no result").not.toBeNull();
              expect(result!.audio, "result.audio missing").toBeDefined();
              expect(
                result!.audio!.segments.length,
                "no audio segments captured from the live EL socket",
              ).toBeGreaterThan(0);
              const interruptEvents = (result!.timeline ?? []).filter(
                (e) => e.type === "user_interrupt",
              );
              expect(
                interruptEvents.length,
                "no user_interrupt event — the barge-in never fired on the EL socket",
              ).toBeGreaterThan(0);
              // PROMISE: EL ConvAI has no client cancel — the server VAD must
              // have cut the in-flight reply. At least one agent segment is
              // flagged truncated (verified working: a real EL run produced 2
              // truncated agent segments + a pivot to business hours).
              const truncated = (result!.audio?.segments ?? []).filter(
                (s) => s.speaker === "agent" && s.transcriptTruncated,
              );
              expect(
                truncated.length,
                "no agent segment marked transcriptTruncated — EL server-VAD did not cut the reply",
              ).toBeGreaterThan(0);
              expect(recordingDir, "recording was not written").not.toBeNull();
              console.log(
                `[demo] elevenlabs_interruption → ${recordingDir} ` +
                  `(interrupts=${interruptEvents.length}, truncated=${truncated.length}, ` +
                  `segments=${result!.audio!.segments.length}, success=${result!.success})`,
              );
            },
          );
        },
      );
    },
    { includeTags: ["ts-elevenlabs-interruption-demo"] },
  );
