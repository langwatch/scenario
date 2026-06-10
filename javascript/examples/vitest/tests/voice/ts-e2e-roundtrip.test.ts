/**
 * @ts-e2e ROUND-TRIP AUDIO FIDELITY GATE — docs/adr/003-voice-internal-design.md §8.
 *
 * The key regression guard for the Gap #3 LIVE BUG. The two audio producers
 * (`messages.ts#createAudioMessage` and the old `adapter.runtime` private
 * encoder) historically tagged PCM differently (`format:"wav"` vs
 * `format:"pcm16"`) and their extractors decoded BY TAG. A format mismatch
 * surfaces as a GARBLED transcript on the far side — and per-PR unit tests,
 * each exercising only its own producer/extractor pair, never cross the seam.
 *
 * This test drives a known utterance through the REAL seam end-to-end:
 *
 *     known text
 *       → user-sim TTS              (UserSimulatorAgent default `_synthesize`
 *                                     → voice/tts#synthesize, openai/<voice>)
 *       → message bus               (createAudioMessage → canonical AI-SDK
 *                                     `file` part, mediaType audio/pcm16)
 *       → judge STT                 (prepareJudgeInput → OpenAISTTProvider
 *                                     → gpt-4o-transcribe)
 *       → far-side transcript
 *
 * and asserts the transcript matches the input within a word-level tolerance.
 * Self-contained on OPENAI_API_KEY (both TTS and STT are OpenAI). NO mocks.
 *
 * Binds `@e2e @ts-e2e` from `specs/voice-agents.feature`. Env-gated: skipped
 * when OPENAI_API_KEY is unset so CI on secret-less branches stays green.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { userSimulatorAgent, voice } from "@langwatch/scenario";
import { expect } from "vitest";

const { createAudioMessage, prepareJudgeInput, OpenAISTTProvider } = voice;

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

/** The known utterance the round-trip must preserve. */
const UTTERANCE = "The quick brown fox jumps over the lazy dog.";

/** Lowercase, strip punctuation, collapse whitespace → comparable word list. */
function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Word-level Jaccard-ish overlap: fraction of input words present in the
 * transcript. A garbled (format-mismatch) transcript scores near 0; a clean
 * round-trip scores 1.0. Tolerance below requires ≥ 0.8 — robust to a single
 * STT substitution (e.g. "the" → "a") without admitting garbage.
 */
function wordOverlap(input: string, transcript: string): number {
  const inWords = normalizeWords(input);
  const outSet = new Set(normalizeWords(transcript));
  if (inWords.length === 0) return 0;
  const hits = inWords.filter((w) => outSet.has(w)).length;
  return hits / inWords.length;
}

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    const Bind = RUN_E2E ? Scenario : Scenario.skip;

    Bind(
      "Round-trip audio fidelity gate — utterance survives TTS → bus → STT",
      ({ Given, When, Then }) => {
        // Only the COMPUTED far-side transcript crosses steps (When → Then),
        // matching the working gemini-live demo pattern. The simulator + STT
        // provider are constructed inside `When` so the round-trip never
        // depends on a mutable object assigned in a prior step (robust under
        // vitest's step retry).
        let farSideTranscript = "";

        Given("a known user utterance and OPENAI_API_KEY", () => {
          expect(UTTERANCE.length).toBeGreaterThan(0);
          expect(Boolean(process.env.OPENAI_API_KEY)).toBe(true);
        });

        When(
          "the utterance is synthesized by the user-sim TTS, carried on the message bus, and transcribed by the judge STT",
          async () => {
            // The user simulator's DEFAULT `_synthesize` IS `voice.synthesize`
            // (see UserSimulatorAgent — `_synthesize = (t, v) => synthesize(t,
            // v)`, the production seam, no stub). We build a real simulator via
            // the documented `userSimulatorAgent({ voice })` factory and read
            // its OWN synthesizer, so the round-trip is identical to what the
            // executor runs per turn.
            const simulator = userSimulatorAgent({ voice: "openai/alloy" });
            const stt = new OpenAISTTProvider();
            const synthesize = (
              simulator as unknown as {
                _synthesize: (t: string, v: string) => Promise<voice.AudioChunk>;
              }
            )._synthesize;

            // 1. user-sim TTS — the same callable the simulator invokes.
            const chunk = await synthesize(UTTERANCE, "openai/alloy");
            expect(chunk.data.length).toBeGreaterThan(0);

            // 2. message bus — the canonical AI-SDK `file` audio part. This is
            //    the producer half of the Gap #3 seam.
            const message = createAudioMessage(chunk, "user");

            // 3. judge STT pre-pass — the consumer half. Transcribes the audio
            //    `file` part back to text exactly as the JudgeAgent does.
            //    `includeAudio: false` forces the text-only transcript path so
            //    we read STT output, not the synthesizer's echoed transcript.
            const prepared = await prepareJudgeInput({
              messages: [message as unknown as import("ai").ModelMessage],
              stt,
              options: { includeAudio: false },
            });

            // Pull the transcribed text part off the far-side message.
            const content = (
              prepared.messages[0] as { content?: unknown }
            ).content;
            const textPart = Array.isArray(content)
              ? content.find(
                  (p): p is { type: "text"; text: string } =>
                    !!p &&
                    typeof p === "object" &&
                    (p as { type?: unknown }).type === "text",
                )
              : undefined;
            farSideTranscript = textPart?.text ?? "";
          },
        );

        Then(
          "the far-side transcript matches the input utterance within tolerance",
          () => {
            // A garbled (format-mismatch) transcript scores near 0; the Gap #3
            // fix keeps the producer/extractor tags aligned so the words
            // survive. Require ≥ 80% word overlap — catches a regression
            // without flaking on a single STT substitution.
            const overlap = wordOverlap(UTTERANCE, farSideTranscript);
            expect(
              farSideTranscript.length,
              `far-side transcript was empty — the audio never round-tripped`,
            ).toBeGreaterThan(0);
            expect(
              overlap,
              `round-trip transcript "${farSideTranscript}" only matched ` +
                `${(overlap * 100).toFixed(0)}% of "${UTTERANCE}" — ` +
                `Gap #3 format mismatch (garbled audio) regression?`,
            ).toBeGreaterThanOrEqual(0.8);
          },
        );
      },
    );
  },
  { includeTags: [["e2e", "ts-e2e"]] },
);
