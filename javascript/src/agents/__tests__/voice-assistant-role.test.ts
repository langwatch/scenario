/**
 * Assistant-role audio test — PR4 of issue #372.
 *
 * Binds 1 scenario from `specs/voice-agents.feature` tagged `@ts-assistant-role`.
 *
 * The scenario verifies that audio content works cleanly in assistant-role
 * messages — there is no `forceUserRole` workaround anywhere in the TS SDK.
 * Audio in any role (user, assistant, tool) round-trips cleanly through the
 * `createAudioMessage` / `extractAudio` helpers and through
 * `JudgeAgent.conversationHasAudio`.
 *
 * This is tagged `@unit` in the feature file (specs/voice-agents.feature)
 * because it touches multiple subsystems (messages.ts + judge voice helpers)
 * at a pure unit level (no LLM, no network). Kept in a separate file per the
 * deliverables spec to maintain clear file-level scoping.
 *
 * Tag convention: `@ts-assistant-role` (per-subject) — see issue #523.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";

import { AudioChunk } from "../../voice/audio-chunk";
import { makeChunk } from "./fixtures/make-chunk";
import { createAudioMessage, extractAudio, messageHasAudio } from "../../voice/messages";
import { JudgeAgent } from "../judge/judge-agent";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "specs",
  "voice-agents.feature"
);


const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    // -----------------------------------------------------------------------
    // Scenario: Audio content works cleanly in assistant-role messages (line 819)
    // -----------------------------------------------------------------------
    Scenario(
      "Audio content works cleanly in assistant-role messages",
      ({ Given, When, Then, And }) => {
        let assistantAudioMessage: unknown;
        let extracted: AudioChunk | null;
        let detectedByJudge: boolean;

        Given(
          "a conversation with an assistant-role message containing audio content",
          () => {
            // Create an audio message in assistant role — no role rewriting needed.
            const chunk = makeChunk("I can help you with that!");
            assistantAudioMessage = createAudioMessage(chunk, "assistant");
            extracted = null;
            detectedByJudge = false;
          }
        );

        When("the judge processes the conversation", () => {
          // extractAudio works for assistant role.
          extracted = extractAudio(assistantAudioMessage);

          // JudgeAgent.conversationHasAudio detects audio in assistant role.
          detectedByJudge = JudgeAgent.conversationHasAudio([
            { role: "user", content: "Hello" },
            assistantAudioMessage,
          ]);
        });

        Then("no role rewriting is needed", () => {
          // The message was produced with role "assistant" — confirmed.
          const msg = assistantAudioMessage as { role: string };
          expect(msg.role).toBe("assistant");

          // audio round-trips: extract succeeds without role rewriting.
          expect(extracted).not.toBeNull();
          expect(extracted).toBeInstanceOf(AudioChunk);
          expect(extracted!.transcript).toBe("I can help you with that!");

          // messageHasAudio works for assistant role.
          expect(messageHasAudio(assistantAudioMessage)).toBe(true);

          // Judge detects the audio.
          expect(detectedByJudge).toBe(true);
        });

        And(
          'no "forceUserRole" style workaround exists anywhere in the Python SDK',
          () => {
            // The TS SDK satisfies this constraint: no role coercion needed.
            // (The step text references "Python SDK" to match the feature file;
            // the intent is that the TS SDK also avoids the workaround — see
            // the scenario comment in specs/voice-agents.feature line 820.)
            // We verify the TS SDK satisfies the spirit: audio in any role
            // (user, assistant, tool via "input_audio") passes through without
            // coercion. We test user and assistant here.

            // User role (already covered by messages.test.ts — smoke check).
            const userMsg = createAudioMessage(makeChunk("hello"), "user");
            expect((userMsg as { role: string }).role).toBe("user");
            expect(messageHasAudio(userMsg)).toBe(true);

            // Assistant role — same API, no workaround.
            const assistantMsg = createAudioMessage(makeChunk("ack"), "assistant");
            expect((assistantMsg as { role: string }).role).toBe("assistant");
            expect(messageHasAudio(assistantMsg)).toBe(true);

            // Both are detected by the judge's static helper.
            const conversation = [userMsg, assistantMsg];
            expect(JudgeAgent.conversationHasAudio(conversation)).toBe(true);
          }
        );
      }
    );
  },
  { includeTags: ["ts-assistant-role"] }
);
