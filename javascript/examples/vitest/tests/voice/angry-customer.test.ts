/**
 * E2E demo — angry customer in a noisy cafe (§6.3), multi-turn.
 *
 * `userSimulatorAgent({ voice, persona, audioEffects: [backgroundNoise("cafe",
 * 0.4), phoneQuality()] })` delivers an emotionally-heightened caller with cafe
 * noise + phone-codec degradation across a multi-turn conversation. The
 * judgeAgent evaluates empathy + noise-robustness + resolution. Mirrors
 * `python/examples/voice/angry_customer.py`.
 *
 * On success the recording lands in `javascript/examples/vitest/outputs/recordings/angry_customer/`
 * (full.wav + manifest).
 *
 * Binds `@e2e @ts-angry-customer-demo`. Env-gated on `OPENAI_API_KEY` AND a
 * reachable bot socket (`SCENARIO_PIPECAT_BOT_UP=1`).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import scenario, { voice, type ScenarioResult } from "@langwatch/scenario";
import { expect } from "vitest";

import { noiseFloorRms } from "./helpers/audio-assertions";
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
      "Demo — angry customer in a noisy cafe (multi-turn)",
      ({ Given, When, Then }) => {
        let result: ScenarioResult | null = null;
        let recordingDir: string | null = null;

        Given(
          "a very-angry user simulator with backgroundNoise + phoneQuality effects",
          () => {
            expect(RUN_E2E).toBe(true);
          },
        );

        When("the multi-turn demo runs via scenario.run()", async () => {
          result = await scenario.run({
            name: "demo_angry_customer",
            description:
              "An angry customer calls from a noisy cafe about a wrong charge. " +
              "The bot must handle the emotional tone and background noise, " +
              "demonstrate empathy, and work toward a resolution.",
            agents: [
              scenario.pipecatAgent({
                url: BOT_WS_URL,
                audioFormat: "mulaw",
                sampleRate: 8000,
              }),
              scenario.userSimulatorAgent({
                // ElevenLabs voice with emotion support — openai/nova read angry
                // text in a CALM tone, defeating the demo. The EXAVITQu4vr4xnSDxMaL
                // voice + the inline tonal markers in the persona below render
                // AUDIBLE anger (mirror python/examples/voice/angry_customer.py).
                voice: "elevenlabs/EXAVITQu4vr4xnSDxMaL",
                // NOTE on brevity: we deliberately do NOT set a maxTokens cap here.
                // The default model is gpt-5-mini, a REASONING model whose reasoning
                // tokens count against maxOutputTokens — any cap tight enough to
                // bound a 1–2 sentence turn (tried 64, then 300) starves the visible
                // completion to empty ("No response content from LLM"). The brevity
                // lever that actually works is the forceful persona below ("1–2 SHORT
                // sentences MAX, NEVER a paragraph"); the < 12s code gate in the Then
                // step is the hard enforcement of the audio side.
                persona:
                  "You are the FURIOUS CUSTOMER who was charged twice and is " +
                  "calling from a noisy cafe. You are NOT the support agent. " +
                  "NEVER apologize, NEVER say sorry, NEVER offer help, NEVER offer " +
                  "empathy, NEVER explain a refund process, NEVER mirror or echo " +
                  "the agent's lines — that is THEIR job, not yours. You only " +
                  "complain, demand the charge be fixed, and stay impatient. Reply " +
                  "with 1–2 SHORT, heated sentences MAXIMUM per turn — never a " +
                  "paragraph. " +
                  "IMPORTANT: format every reply with ElevenLabs tonal markers " +
                  "inline so the synthesised voice sounds audibly angry, not " +
                  "just textually. Use markers like [shouting], [angry], [sigh], " +
                  "[exhales sharply], [frustrated], and keep at least one in EVERY " +
                  "turn. Example: '[shouting] You charged me the wrong amount! " +
                  "[angry] Fix it NOW.' Do not strip the markers — the TTS reads " +
                  "them as performance cues.",
                // Effects (§4.5): cafe ambience + phone-codec degradation
                // layered on the synthesized user audio.
                audioEffects: [
                  voice.effects.backgroundNoise("cafe", 0.4),
                  voice.effects.phoneQuality(),
                ],
              }),
              scenario.judgeAgent({
                // PROMISE-ENCODING criteria — the CONVERSATIONAL half the judge
                // can read from the transcript: empathy, a concrete resolution
                // (a hollow bot that deflects FAILS), and an emotionally
                // heightened caller whose turns carry the ElevenLabs tonal
                // markers that DRIVE the audible-anger synthesis. The AUDIO half
                // — that the markers actually rendered an angry VOICE (not neutral
                // nova) and that cafe noise + phone codec were really MIXED onto
                // the line — is asserted in CODE in the Then step (the effect
                // pipeline ran on EL audio); an LLM judge reading text cannot
                // confirm a waveform property. A reviewer can also play full.wav.
                criteria: [
                  "The agent demonstrated empathy toward the angry customer and stayed calm despite the hostility",
                  "The agent offered a concrete resolution or next step (a refund, a correction of the charge, escalation to a supervisor) rather than deflecting",
                  "The user is an emotionally heightened, impatient caller whose turns carry inline tonal/performance cues (e.g. [shouting], [angry], [frustrated]) — not a calm, neutral speaker",
                  "The conversation is a coherent example of an angry-customer-in-a-noisy-cafe scenario",
                ],
              }),
            ],
            // Voice convention: the bot greets first. Two full heated exchanges
            // (greeting + user + agent + user + agent). Kept to two exchanges
            // (no proceed) so the angry persona's verbose turns don't push the
            // committed full.wav past the 1MB cap even at 8kHz.
            script: [
              scenario.agent(),
              scenario.user(),
              scenario.agent(),
              scenario.user(),
              scenario.agent(),
              scenario.judge(),
            ],
            maxTurns: 8,
          });
          recordingDir = saveDemoRecording(result.audio, "angry_customer", {
            downsampleHz: 8000,
          });
        });

        Then("the agent stays calm, noise is audibly mixed, and the judge passes", () => {
          expect(result, "scenario.run() returned no result").not.toBeNull();
          expect(result!.audio, "result.audio missing").toBeDefined();
          const segments = result!.audio!.segments;
          const speakers = new Set(segments.map((s) => s.speaker));
          expect(speakers.has("user"), "no user-sim audio").toBe(true);
          expect(speakers.has("agent"), "no agent audio").toBe(true);
          // Multi-turn: greeting + ≥2 user turns → ≥4 segments.
          expect(
            segments.length,
            "expected a multi-turn recording",
          ).toBeGreaterThanOrEqual(4);

          // PROMISE-ENCODING gate (the "short heated turns" half a transcript-only
          // judge can silently pass): an ANGRY customer fires 1–2 short sentences,
          // never an agent-style empathy monologue. We saw role-reversal drift
          // produce a 31s "I'm really sorry…" user turn that the criteria did not
          // catch. Assert EVERY user segment is short. In-memory segment PCM is
          // 24kHz mono PCM16 (see noiseFloorRms's 480-sample/20ms frame); duration
          // = bytes / 2 / 24000. Bound 12s ≈ 1.7× the good turn-1 (~6.8s) — generous
          // enough to survive run-to-run jitter, tight enough to fail a 31s monologue.
          const userDurations = segments
            .filter((s) => s.speaker === "user")
            .map((s) => s.audio.length / 2 / 24000);
          const maxUserSegDuration = Math.max(0, ...userDurations);
          expect(
            maxUserSegDuration,
            `a user (angry-customer) turn ran ${maxUserSegDuration.toFixed(1)}s — ` +
              `too long for a 1–2 sentence heated turn (role-reversal drift / no token cap?). ` +
              `durations=[${userDurations.map((d) => d.toFixed(1)).join(", ")}]`,
          ).toBeLessThan(12);

          // AUDIO-PROPERTY proof (the half the LLM judge cannot see): the cafe
          // ambience was actually MIXED onto the user's TTS — not a silent
          // placeholder, not a no-op effect (the bundled-asset dist-path bug
          // that made backgroundNoise a no-op is fixed). Clean TTS has
          // near-silence between words; with cafe noise mixed, even the QUIET
          // frames carry murmur energy. Measure the noise FLOOR of the longest
          // user segment (the 10th-percentile frame RMS) — it must be well above
          // digital silence.
          const userSegs = segments
            .filter((s) => s.speaker === "user" && s.audio.length > 4800)
            .sort((a, b) => b.audio.length - a.audio.length);
          expect(userSegs.length, "no substantial user segment to measure").toBeGreaterThan(0);
          const floor = noiseFloorRms(userSegs[0]!.audio);
          // A clean TTS segment's quiet-frame RMS is ~0-20; cafe ambience at
          // 0.4 volume lifts the floor well past that. Generous threshold so the
          // assertion is robust across runs but still fails a silent/no-op mix.
          expect(
            floor,
            `user audio noise floor (${floor.toFixed(0)}) too low — cafe ambience was not audibly mixed`,
          ).toBeGreaterThan(60);

          expect(recordingDir, "recording was not written").not.toBeNull();
          console.log(
            `[demo] angry_customer → ${recordingDir} ` +
              `(segments=${segments.length}, userNoiseFloorRms=${floor.toFixed(0)}, ` +
              `success=${result!.success})`,
          );
          // The CONVERSATIONAL promise (empathy + concrete resolution + heightened
          // persona with tonal markers) is the judge's job.
          expect(result!.success, `judge verdict: ${result!.reasoning}`).toBe(true);
        });
      },
    );
  },
  { includeTags: ["ts-angry-customer-demo"] },
);
