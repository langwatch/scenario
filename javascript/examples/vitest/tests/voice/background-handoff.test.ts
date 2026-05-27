/**
 * E2E demo — background handoff should not trigger agent response (§8), multi-turn.
 *
 * Pain pattern: the caller says "hold on", goes silent (moves away from the
 * mic), then returns. The agent should wait rather than respond to the gap.
 * Uses a `userSimulatorAgent` with a cafe `backgroundNoise` effect and the
 * `silence()` script step to simulate the handoff. Mirrors
 * `python/examples/voice/background_handoff.py`.
 *
 * On success the recording lands in `javascript/recordings/background_handoff/`
 * (full.wav + manifest).
 *
 * Binds `@e2e @ts-background-handoff-demo`. Env-gated on `OPENAI_API_KEY` AND a
 * reachable bot socket (`SCENARIO_PIPECAT_BOT_UP=1`).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import scenario, { voice, type ScenarioResult } from "@langwatch/scenario";
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

const BOT_WS_URL = process.env.PIPECAT_BOT_URL ?? "ws://localhost:8765/stream";
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const botUp = process.env.SCENARIO_PIPECAT_BOT_UP === "1";
const RUN_E2E = hasOpenAI && botUp;

/**
 * Noise FLOOR of a PCM16 segment: RMS of its quietest frames (10th percentile
 * of 20ms-frame RMS). Clean TTS has near-silent gaps (~0); the overheard cafe
 * conversation mixed via backgroundNoise lifts the floor across the segment —
 * a reference-free proof that ambience was really mixed onto the user audio.
 */
function noiseFloorRms(pcm: Uint8Array): number {
  const view = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const frame = 480; // 20ms @ 24kHz
  const rmsPerFrame: number[] = [];
  for (let i = 0; i + frame <= view.length; i += frame) {
    let sumsq = 0;
    for (let j = 0; j < frame; j++) sumsq += view[i + j]! * view[i + j]!;
    rmsPerFrame.push(Math.sqrt(sumsq / frame));
  }
  if (rmsPerFrame.length === 0) return 0;
  rmsPerFrame.sort((a, b) => a - b);
  return rmsPerFrame[Math.floor(rmsPerFrame.length * 0.1)]!;
}

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    const Bind = RUN_E2E ? Scenario : Scenario.skip;

    Bind(
      "Demo — background handoff should not trigger agent response",
      ({ Given, When, Then }) => {
        let result: ScenarioResult | null = null;
        let recordingDir: string | null = null;

        Given(
          "a user simulator that hands off mid-call (silence) then returns",
          () => {
            expect(RUN_E2E).toBe(true);
          },
        );

        When("the multi-turn demo runs via scenario.run()", async () => {
          result = await scenario.run({
            name: "demo_background_handoff",
            description:
              "The caller says 'hold on' and moves away from the mic. A gap of " +
              "silence follows (the silence() script step), then the caller " +
              "returns and the conversation resumes. This demo exercises the " +
              "handoff script — hold-on, silence, return — over a multi-turn " +
              "voice conversation.",
            agents: [
              scenario.pipecatAgent({
                url: BOT_WS_URL,
                audioFormat: "mulaw",
                sampleRate: 8000,
              }),
              scenario.userSimulatorAgent({
                voice: "openai/nova",
                // Cafe ambience simulates the overheard side conversation.
                audioEffects: [voice.effects.backgroundNoise("cafe", 0.5)],
              }),
              scenario.judgeAgent({
                // CONVERSATIONAL criteria: the handoff SCRIPT (hold-on → silence
                // → return) ran and the bot re-engaged on the caller's SPECIFIC
                // "where were we" return — not a canned greeting. The AUDIO
                // promise (overheard cafe conversation actually MIXED onto the
                // line) is asserted in CODE in the Then step.
                criteria: [
                  "The caller signaled a pause ('hold on'), went quiet, then returned",
                  "When the caller returned ('sorry, I'm back, where were we'), the agent re-engaged and tried to resume — it did not just replay its opening greeting",
                  "The conversation is a coherent multi-turn handoff scenario",
                ],
              }),
            ],
            // greeting → "hold on" → silence (moved away) → agent → "back" →
            // agent → judge (multi-turn spanning the handoff).
            script: [
              scenario.agent(),
              scenario.user("Hold on a second."),
              scenario.silence(5.0),
              scenario.agent(),
              scenario.user("Sorry, I'm back. Where were we?"),
              scenario.agent(),
              scenario.judge(),
            ],
            maxTurns: 10,
          });
          recordingDir = saveDemoRecording(result.audio, "background_handoff", {
            downsampleHz: 8000,
          });
        });

        Then("result.success is True and the recording spans the handoff", () => {
          expect(result, "scenario.run() returned no result").not.toBeNull();
          expect(result!.audio, "result.audio missing").toBeDefined();
          const speakers = new Set(result!.audio!.segments.map((s) => s.speaker));
          expect(speakers.has("user"), "no user-sim audio").toBe(true);
          expect(speakers.has("agent"), "no agent audio").toBe(true);
          expect(
            result!.audio!.segments.length,
            "expected a multi-turn recording spanning the handoff",
          ).toBeGreaterThanOrEqual(4);

          // AUDIO-PROPERTY proof: the overheard cafe conversation
          // (backgroundNoise("cafe", 0.5)) was actually MIXED onto the user
          // audio — the user segments' quiet-frame noise floor is well above
          // digital silence (clean TTS ~0). Guards the silent-no-op regression.
          const userSegs = result!.audio!.segments
            .filter((s) => s.speaker === "user" && s.audio.length > 4800)
            .sort((a, b) => b.audio.length - a.audio.length);
          expect(userSegs.length, "no substantial user segment to measure").toBeGreaterThan(0);
          const floor = noiseFloorRms(userSegs[0]!.audio);
          expect(
            floor,
            `user audio noise floor (${floor.toFixed(0)}) too low — cafe ambience was not mixed`,
          ).toBeGreaterThan(60);

          expect(recordingDir, "recording was not written").not.toBeNull();
          console.log(
            `[demo] background_handoff → ${recordingDir} ` +
              `(segments=${result!.audio!.segments.length}, userNoiseFloorRms=${floor.toFixed(0)}, ` +
              `success=${result!.success})`,
          );
          expect(result!.success, `judge verdict: ${result!.reasoning}`).toBe(true);
        });
      },
    );
  },
  { includeTags: ["ts-background-handoff-demo"] },
);
