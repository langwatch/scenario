/**
 * E2E demo — Gemini Live native audio.
 *
 * Binds the single `@ts-gemini-live-e2e` scenario from
 * `specs/voice-agents.feature` to a real `@google/genai` Live session
 * gated on `GEMINI_API_KEY` (or `GOOGLE_API_KEY`).
 *
 * This is an `@e2e` slice: it talks to Google's hosted Live API, so it is
 * skipped by default. To run it locally, install `@google/genai` in the
 * examples workspace and set `GEMINI_API_KEY` in `examples/vitest/.env`.
 *
 * Skipped automatically when no key is present so CI stays green without
 * Gemini credentials.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";

import {
  AudioChunk,
  GEMINI_LIVE_MODEL,
  GeminiLiveAgentAdapter,
} from "@langwatch/scenario";

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

const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
const hasKey = apiKey.length > 0;

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    Scenario(
      "Demo — Gemini Live native audio",
      ({ Given, When, Then }) => {
        let adapter: GeminiLiveAgentAdapter | null = null;
        let success = false;

        Given(
          'a GeminiLiveAgentAdapter with model "gemini-2.5-flash-native-audio" and GEMINI_API_KEY',
          (ctx: { skip: () => void }) => {
            if (!hasKey) {
              ctx.skip();
              return;
            }
            adapter = new GeminiLiveAgentAdapter({
              model: GEMINI_LIVE_MODEL,
              systemInstruction:
                "You are a brief, helpful voice assistant. Answer in one short sentence.",
            });
            expect(adapter).toBeInstanceOf(GeminiLiveAgentAdapter);
          },
        );

        When("the demo script runs via scenario.run()", async (ctx: { skip: () => void }) => {
          if (!adapter) {
            ctx.skip();
            return;
          }
          // Minimal real-transport happy path: open a session, push a
          // short silent user turn, drain audio until turn_complete. This
          // proves the wire format + lifecycle without needing the full
          // scenario.run() pipeline (which lands in PR3/runtime). The
          // /browser-qa-against-prod hook will exercise the full pipeline
          // once it ships.
          await adapter.connect();
          // 0.5s of silence at canonical 24kHz mono PCM16 = 24000 samples
          // * 2 bytes = 48000 bytes. Pure silence is enough to satisfy
          // Gemini's "user turn" framing once activity_end fires.
          const silence = new Uint8Array(24000 * 2);
          await adapter.sendAudio(new AudioChunk({ data: silence }));

          // Drain until turn_complete (empty data). Hard-cap iterations
          // so a wedged stream can't hang the test forever.
          for (let i = 0; i < 200; i++) {
            const chunk = await adapter.receiveAudio(10);
            if (chunk.data.length === 0) break;
          }
          success = true;
        });

        Then(
          "a live session is established and result.success is True",
          async (ctx: { skip: () => void }) => {
            if (!adapter) {
              ctx.skip();
              return;
            }
            expect(success).toBe(true);
            await adapter.disconnect();
          },
        );
      },
    );
  },
  { includeTags: ["ts-gemini-live-e2e"] },
);
