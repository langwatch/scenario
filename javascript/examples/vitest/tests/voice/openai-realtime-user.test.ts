/**
 * E2E demo — OpenAI Realtime as the user simulator (`role=AgentRole.USER`).
 *
 * Proof for §7.2 (L1164-1171): scripted `user("text")` lines route through
 * the realtime session's TEXT-input channel (`sendText`), NOT through TTS —
 * the model converts the text into spoken audio with natural prosody on the
 * server side. We capture that spoken audio across a MULTI-TURN sequence (two
 * scripted user lines → two spoken user segments) and save it as the recording.
 *
 * SCOPE — adapter-level proof: this demo proves the §7.2 seam in isolation
 * (scripted text → natural-prosody spoken audio off the realtime socket). The
 * Python twin (`python/examples/voice/openai_realtime_user.py`) likewise SKIPS
 * the full `scenario.run()` ("Phase-2 gap").
 *
 * The cross-adapter bridge is now CLOSED in the TS executor (#705): the
 * realtime-user `user("...")` path drains the spoken audio and routes it (as an
 * audio ModelMessage + the model's spoken transcript) to a separate agent under
 * test. For the END-TO-END proof — a realtime user driving a hosted ElevenLabs
 * agent over MULTI-TURN through `scenario.run()` — see
 * `realtime-user-hosted-el.test.ts`. This file stays an isolated adapter demo.
 *
 * Binds `@e2e @ts-openai-realtime-user-demo`. Env-gated on `OPENAI_API_KEY`.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { AgentRole, voice } from "@langwatch/scenario";
import { expect } from "vitest";

import { saveDemoRecording } from "./helpers/save-demo-recording";

const { AudioChunk, OPENAI_REALTIME_MODEL, OpenAIRealtimeAgentAdapter, VoiceRecordingRuntime } =
  voice;

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

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    const Bind = RUN_E2E ? Scenario : Scenario.skip;

    Bind(
      "Demo — OpenAI Realtime as the user simulator",
      ({ Given, When, Then, And }) => {
        // Only the captured chunk crosses steps (When → Then).
        let firstChunk: voice.AudioChunk | null = null;
        let recordingDir: string | null = null;
        let spokenSegments = 0;

        Given(
          "an OpenAIRealtimeAgentAdapter with role=AgentRole.USER and a confused-elderly-customer persona",
          () => {
            expect(Boolean(process.env.OPENAI_API_KEY)).toBe(true);
          },
        );

        When("the demo script runs via scenario.run()", async () => {
          const adapter = new OpenAIRealtimeAgentAdapter({
            model: OPENAI_REALTIME_MODEL,
            // GA Realtime voices: alloy, ash, ballad, coral, echo, sage,
            // shimmer, verse, marin, cedar. `marin` is the closest fit to the
            // BDD's documented "nova" persona intent.
            voice: "marin",
            instructions:
              "You are a confused elderly customer trying to reset your password. " +
              "Speak slowly with hesitation.",
            role: AgentRole.USER,
          });
          expect(adapter.role).toBe(AgentRole.USER);

          const recording = new VoiceRecordingRuntime();

          /**
           * Send one scripted line through the realtime USER channel and drain
           * the spoken audio the model synthesizes for it. The realtime adapter
           * THROWS a timeout once the model stops speaking (no further audio
           * deltas) — that is the natural end-of-turn signal, so we break on it.
           * Returns the merged PCM16 bytes for the turn (empty if none).
           */
          async function speakTurn(text: string): Promise<Uint8Array> {
            // sendText is the user-role path: scripted text goes straight into
            // the realtime session as an input_text content part — NO TTS.
            await adapter.sendText(text);
            const chunks: Uint8Array[] = [];
            for (let i = 0; i < 200; i++) {
              let chunk: voice.AudioChunk;
              try {
                chunk = await adapter.receiveAudio(15);
              } catch {
                break; // end of the model's spoken turn
              }
              if (chunk.data.length === 0) break;
              if (!firstChunk) firstChunk = chunk;
              chunks.push(chunk.data);
            }
            const total = chunks.reduce((s, c) => s + c.length, 0);
            const merged = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
              merged.set(c, off);
              off += c.length;
            }
            return merged;
          }

          try {
            await adapter.connect();
            // MULTI-TURN: TWO scripted user lines, each spoken by the realtime
            // model with natural prosody. Segments are laid end-to-end on a
            // byte-accurate cursor so manifest.duration == full.wav byte-duration
            // (the M1 invariant).
            const lines = [
              "I forgot my password and need help.",
              "Oh — and I also can't remember my username.",
            ];
            let cursorSeconds = 0;
            for (const line of lines) {
              const merged = await speakTurn(line);
              if (merged.length === 0) continue;
              const seconds = merged.length / 2 / 24000;
              recording.segments.push({
                speaker: "user",
                startTime: cursorSeconds,
                endTime: cursorSeconds + seconds,
                audio: merged,
                transcript: adapter.lastAgentTranscript ?? line,
              });
              cursorSeconds += seconds;
            }

            // Save the captured spoken-user audio as the demo recording.
            spokenSegments = recording.segments.length;
            if (recording.segments.length > 0) {
              recordingDir = saveDemoRecording(recording, "openai_realtime_user");
            }
          } finally {
            await adapter.disconnect();
          }
        });

        Then(
          'scripted user("text") lines are delivered with natural prosody',
          () => {
            expect(firstChunk, "no spoken audio captured").not.toBeNull();
            expect(firstChunk).toBeInstanceOf(AudioChunk);
            expect(firstChunk!.data.length).toBeGreaterThan(0);
          },
        );

        And("text TTS is bypassed for the user simulator", () => {
          // The only injection path used was `sendText`; no TTS module touched.
          // The live audio is generated by the realtime model itself.
          expect(recordingDir, "recording was not written").not.toBeNull();
          // MULTI-TURN: both scripted user lines were spoken and captured as two
          // distinct user audio segments.
          expect(
            spokenSegments,
            "expected two spoken user turns (multi-turn)",
          ).toBeGreaterThanOrEqual(2);
          console.log(
            `[demo] openai_realtime_user → ${recordingDir} (${spokenSegments} spoken user turns)`,
          );
        });
      },
    );
  },
  { includeTags: ["ts-openai-realtime-user-demo"] },
);
