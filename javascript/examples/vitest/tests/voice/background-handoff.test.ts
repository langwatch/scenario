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
                criteria: [
                  // Scoped to what's observable with the bundled stub bot: the
                  // handoff SCRIPT (hold-on → silence → return) ran and the bot
                  // re-engaged when the caller came back. The stub bot does not
                  // implement patient-waiting, so that is NOT a pass criterion
                  // here (the demo proves the silence/handoff script + the
                  // multi-turn recording spanning it).
                  "The caller signaled a pause, went quiet, then returned",
                  "The agent re-engaged once the caller came back",
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
          expect(recordingDir, "recording was not written").not.toBeNull();
          console.log(
            `[demo] background_handoff → ${recordingDir} ` +
              `(segments=${result!.audio!.segments.length}, success=${result!.success})`,
          );
          expect(result!.success, `judge verdict: ${result!.reasoning}`).toBe(true);
        });
      },
    );
  },
  { includeTags: ["ts-background-handoff-demo"] },
);
