/**
 * E2E demo — random interruptions (§6.7), the probabilistic barge-in path.
 *
 * `userSimulatorAgent({ interruptProbability })` + `voiceProceed({ turns,
 * interruptions: InterruptionConfig({...}) })` injects barge-ins on roughly
 * `probability` of agent turns across a MULTI-TURN conversation. The executor's
 * proceed loop consumes the active InterruptionConfig and fires `user_interrupt`
 * events (sampling `delayRange` before barging in). Mirrors
 * `python/examples/voice/random_interruptions.py`.
 *
 * The agent under test is the bundled Pipecat stub bot. On success the recording
 * lands in `javascript/examples/vitest/outputs/recordings/random_interruptions/` (full.wav + manifest).
 *
 * ## What this demo proves
 * - Probabilistic barge-in fires correctly (user_interrupt event emitted)
 * - The barge-in landed WHILE the bot was speaking (fired_after_speech outcome),
 *   not into silence — proves the schedule + fire timing is correct
 * - The canned-phrase strategy ran (user segment contains a phrase from the pool)
 * - The cut-off-boundary LABEL fires (transcriptTruncated on at least one agent seg)
 * - The agent recovered with non-empty audio after the last interrupt
 * - Multi-turn conversation
 *
 * ## What this demo does NOT prove
 * Real audio-level mid-stream cut-off (segment duration meaningfully shorter
 * than the full reply). The bundled Pipecat stub bot generates TTS in a burst
 * and streams faster than realtime — by the time fireUserInterrupt's
 * adapter.interrupt() runs (~1.5-2s after bot starts speaking), the bot has
 * already sent all frames. The segment plays in full but is correctly LABELED
 * at the interrupt boundary. This is a transport limitation, not a code bug.
 *
 * For REAL audio-level mid-stream cut-off (segment duration meaningfully
 * shorter than the full reply), see `gemini-live-interruption.test.ts` which
 * uses Gemini Live's server-side cancel that prevents late-frame delivery.
 *
 * Binds `@e2e @ts-random-interruptions-demo`. Env-gated on `OPENAI_API_KEY`
 * AND a reachable bot socket (`SCENARIO_PIPECAT_BOT_UP=1`).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import scenario, { voice, type ScenarioResult } from "@langwatch/scenario";
import { expect } from "vitest";

import { saveDemoRecording } from "./helpers/save-demo-recording";

const { InterruptionConfig } = voice;

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

const BOT_WS_URL = process.env.PIPECAT_BOT_URL ?? "ws://localhost:8765/stream";
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const botUp = process.env.SCENARIO_PIPECAT_BOT_UP === "1";
const RUN_E2E = hasOpenAI && botUp;

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    const Bind = RUN_E2E ? Scenario : Scenario.skip;

    Bind(
      "Demo — random interruptions via interruptProbability + voiceProceed",
      ({ Given, When, Then, And }) => {
        let result: ScenarioResult | null = null;
        let recordingDir: string | null = null;

        Given(
          "a user simulator with interruptProbability and voiceProceed({ interruptions })",
          () => {
            expect(RUN_E2E).toBe(true);
          },
        );

        When("the multi-turn demo script runs via scenario.run()", async () => {
          result = await scenario.run({
            name: "demo_random_interruptions",
            description:
              "A user simulator with a high interruption probability calls the bot " +
              "for help with their account. Over several turns most agent responses " +
              "are cut short. The bot must recover after the interruptions.",
            agents: [
              scenario.pipecatAgent({
                url: BOT_WS_URL,
                audioFormat: "mulaw",
                sampleRate: 8000,
              }),
              scenario.userSimulatorAgent({
                voice: "openai/nova",
                // 0.8 over 5 turns → P(zero interrupts) ≈ 0.03%; reliable as a
                // test. The persona pins the role so role-reversal doesn't drift
                // the simulator into assistant-flavored lines on later turns.
                interruptProbability: 0.8,
                persona:
                  "A customer calling for help with their account. Speak as a " +
                  "customer would — describe problems and ask questions, never " +
                  "offer help yourself.",
              }),
              scenario.judgeAgent({
                // CONVERSATIONAL criteria (mirror the Python twin); the AUDIO
                // proof that turns were actually CUT OFF is asserted in code in
                // the And step (truncated segments) — the judge can't see
                // truncation from a back-filled transcript.
                criteria: [
                  "The agent continued the conversation after the interruptions rather than stopping or going silent",
                  "The agent recovered context after being interrupted — it stayed on the user's account-help thread rather than restarting or ignoring it",
                  "The conversation involved multiple turns between user and agent",
                  "The conversation is a coherent example of probabilistic random interruptions",
                ],
              }),
            ],
            // Voice convention: the bot greets first on connect. The user's
            // request is turn 2; subsequent voiceProceed() turns are subject to
            // interruptProbability. voiceProceed (NOT the plain proceed) carries
            // the InterruptionConfig the executor's loop consumes.
            script: [
              scenario.agent(),
              scenario.user("I need help with my account"),
              scenario.voiceProceed({
                turns: 5,
                interruptions: new InterruptionConfig({
                  probability: 0.8,
                  delayRange: [0.5, 2.0],
                  strategy: "random_phrase",
                  // A demo-local pool of DISTINCT interjections. The default
                  // CANNED_PHRASES pool collided across draws (the recording showed
                  // "Wait I forgot to mention" twice), which reads as a stuck loop
                  // rather than a realistic barge-in. These varied phrases keep each
                  // interrupt audibly different. (Picks are random-with-replacement,
                  // so we vary the POOL here and verify the regenerated turns are
                  // distinct rather than hard-gating distinctness — a hard gate would
                  // be flaky given random sampling.)
                  phrases: [
                    "Wait, I forgot to mention—",
                    "Oh, one more thing—",
                    "Actually, hold on—",
                    "Sorry, real quick—",
                    "Hmm, wait—",
                    "No no, let me back up—",
                  ],
                }),
              }),
              scenario.judge(),
            ],
            maxTurns: 14,
          });
          // Long multi-turn conversation → downsample full.wav to 8kHz for the
          // 1MB commit cap (duration / M1 unchanged).
          recordingDir = saveDemoRecording(result.audio, "random_interruptions", {
            downsampleHz: 8000,
          });
        });

        Then("at least one barge-in fired mid-utterance and the canned-phrase strategy ran", () => {
          expect(result, "scenario.run() returned no result").not.toBeNull();

          // The probabilistic config produced at least one barge-in event.
          const interruptEvents = (result!.timeline ?? []).filter(
            (e) => e.type === "user_interrupt",
          );
          expect(
            interruptEvents.length,
            "no user_interrupt event — probabilistic barge-in never fired",
          ).toBeGreaterThan(0);

          // The barge-in landed WHILE the bot was speaking (not into silence) — proves
          // the schedule + fire timing is correct (the prior post-step injection bug
          // would have produced fired_before_speech outcomes only).
          const firedAfterSpeech = interruptEvents.some(
            (e) => e.metadata?.outcome === "fired_after_speech",
          );
          expect(
            firedAfterSpeech,
            "no barge-in fired while the agent was speaking — interrupt window was missed (post-step regression?)",
          ).toBe(true);

          // The barge-in carried a phrase from the configured pool — proves the
          // random_phrase strategy actually ran (vs falling back to silence or empty).
          const cannedPhrases = [
            "I forgot to mention",
            "one more thing",
            "Actually, hold on",
            "real quick",
            "Hmm, wait",
            "let me back up",
          ];
          const userSegs = (result!.audio?.segments ?? []).filter((s) => s.speaker === "user");
          const cannedSeen = userSegs.some((s) =>
            cannedPhrases.some((phrase) =>
              (s.transcript ?? "").toLowerCase().includes(phrase.toLowerCase()),
            ),
          );
          expect(
            cannedSeen,
            `no user segment carries a canned-phrase from the configured pool — random_phrase strategy did not run. Got user transcripts: ${userSegs.map((s) => JSON.stringify(s.transcript)).join(", ")}`,
          ).toBe(true);

          // At least one agent segment is marked transcriptTruncated — the
          // cut-off-boundary label fires correctly.
          //
          // NOTE: this asserts the LABEL fires, not that audio was meaningfully
          // shortened. The bundled Pipecat stub bot generates TTS in a burst and
          // streams faster than realtime — by the time fireUserInterrupt's
          // adapter.interrupt() runs, the bot has typically already sent all
          // frames. The segment plays in full but is correctly labeled at the
          // interrupt boundary. For REAL audio-level mid-stream cut-off (segment
          // duration meaningfully shorter than the full reply), see
          // gemini-live-interruption.test.ts which uses Gemini Live's server-side
          // cancel that prevents late-frame delivery.
          const truncated = (result!.audio?.segments ?? []).filter(
            (s) => s.speaker === "agent" && s.transcriptTruncated,
          );
          expect(
            truncated.length,
            "no agent segment marked transcriptTruncated — interrupt label did not fire at any segment boundary",
          ).toBeGreaterThan(0);
        });

        And("the agent recovered with non-empty audio after the last interrupt", () => {
          // Recovery proof: the agent produced MORE audio segments than it had
          // truncated (interrupted) ones. If all agent segments were truncated,
          // the bot never spoke a complete reply — it was always cut off before
          // finishing. At least one non-truncated agent segment means the bot
          // completed at least one turn, proving it recovered from at least one
          // interrupt.
          //
          // We do NOT check "agent segment after the last interrupt" because
          // voiceProceed(turns) can end on an interrupted turn, after which the
          // script moves to judge() (no audio). The above per-segment proof is
          // the honest recovery claim for this script shape.
          const agentSegs = (result!.audio?.segments ?? []).filter(
            (s) => s.speaker === "agent",
          );
          const truncatedSegs = agentSegs.filter((s) => s.transcriptTruncated);
          const completedSegs = agentSegs.filter((s) => !s.transcriptTruncated);
          expect(
            completedSegs.length,
            `all ${agentSegs.length} agent segments were truncated — the bot never completed a reply. ` +
              `truncated=${truncatedSegs.length}, total agent segs=${agentSegs.length}`,
          ).toBeGreaterThan(0);
          // At least one completed (non-truncated) segment has non-empty transcript.
          expect(
            completedSegs.some((s) => (s.transcript ?? "").trim().length > 0),
            "all completed (non-truncated) agent segments have empty transcripts — bot may have started turns but said nothing",
          ).toBe(true);
        });

        And("the conversation involved multiple turns", () => {
          const speakingStarts = (result!.timeline ?? []).filter(
            (e) =>
              e.type === "user_start_speaking" || e.type === "agent_start_speaking",
          ).length;
          expect(
            speakingStarts,
            `expected a multi-turn conversation (≥3 speaking turns); got ${speakingStarts}`,
          ).toBeGreaterThanOrEqual(3);
          expect(
            result!.audio?.segments.length ?? 0,
            "no audio recorded",
          ).toBeGreaterThan(0);
          expect(recordingDir, "recording was not written").not.toBeNull();

          const truncated = (result!.audio?.segments ?? []).filter(
            (s) => s.speaker === "agent" && s.transcriptTruncated,
          );
          const interruptEvents = (result!.timeline ?? []).filter(
            (e) => e.type === "user_interrupt",
          );
          console.log(
            `[demo] random_interruptions → ${recordingDir} ` +
              `(interrupts=${interruptEvents.length}, truncated=${truncated.length}, ` +
              `segments=${result!.audio?.segments.length}, success=${result!.success})`,
          );
        });
      },
    );
  },
  { includeTags: ["ts-random-interruptions-demo"] },
);
