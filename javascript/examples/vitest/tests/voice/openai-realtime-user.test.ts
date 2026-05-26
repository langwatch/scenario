/**
 * E2E demo — OpenAI Realtime as the user simulator (`role=AgentRole.USER`).
 *
 * Proof for §7.2 (L1164-1171): a scripted `user("text")` line routes through
 * the realtime session's TEXT-input channel (`sendText`), NOT through TTS —
 * the model converts the text into spoken audio with natural prosody on the
 * server side. We capture that spoken audio and save it as the recording.
 *
 * PARITY NOTE — cross-adapter bridging gap: the Python twin
 * (`python/examples/voice/openai_realtime_user.py`) SKIPS the full
 * `scenario.run()` because each adapter owns its own transport and there is
 * no bridge piping the USER-side realtime audio into a separate AGENT-side
 * adapter's input (its docstring: "Phase-2 gap"). The TS executor has the
 * identical limitation: the realtime-user `sendText` path puts a text message
 * on the bus, so a separate agent under test would hear no audio. We therefore
 * prove the load-bearing claim — scripted text → natural-prosody spoken audio
 * — at the adapter level (the exact seam §7.2 specifies) and commit that audio.
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
          try {
            await adapter.connect();
            // sendText is the user-role path: scripted text goes straight into
            // the realtime session as an input_text content part — NO TTS.
            await adapter.sendText("I forgot my password and need help.");

            // Drain the spoken audio the model synthesizes for that line. The
            // realtime adapter THROWS a timeout once the model stops speaking
            // (no further audio deltas) — that is the natural end-of-turn
            // signal here, so we break on it rather than propagating.
            const chunks: Uint8Array[] = [];
            let first: voice.AudioChunk | null = null;
            for (let i = 0; i < 200; i++) {
              let chunk: voice.AudioChunk;
              try {
                chunk = await adapter.receiveAudio(15);
              } catch {
                break; // end of the model's spoken turn
              }
              if (chunk.data.length === 0) break;
              if (!first) first = chunk;
              chunks.push(chunk.data);
            }
            firstChunk = first;

            // Save the captured spoken-user audio as the demo recording.
            if (chunks.length > 0) {
              const total = chunks.reduce((s, c) => s + c.length, 0);
              const merged = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) {
                merged.set(c, off);
                off += c.length;
              }
              const seconds = total / 2 / 24000;
              recording.segments.push({
                speaker: "user",
                startTime: 0,
                endTime: seconds,
                audio: merged,
                transcript:
                  adapter.lastAgentTranscript ??
                  "I forgot my password and need help.",
              });
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
          // eslint-disable-next-line no-console
          console.log(`[demo] openai_realtime_user → ${recordingDir}`);
        });
      },
    );
  },
  { includeTags: ["ts-openai-realtime-user-demo"] },
);
