// Proof that the tightened audio judge criteria DISCRIMINATE (#680).
//
// #680 is a false-pass bug: the old criteria let two broken agents through.
// Tightening the wording is only a fix if the judge now actually FAILS those
// two cases — a criterion that passes everything is theatre. This test scripts
// the three responses that matter and asserts the verdicts:
//
//   1. a genuine answer                       -> PASS  (the criteria are not just strict)
//   2. a content-free "I heard your audio"    -> FAIL  (#680 gap 1, vacuous green)
//   3. a polite "I can't process audio files" -> FAIL  (#680 gap 2, deflection)
//
// It uses NO audio and NO audio model: both sides are scripted text via
// scenario.message(), and the judge grades the transcript with the exact same
// AUDIO_JUDGE_CRITERIA the three audio examples import. That keeps the proof
// deterministic in shape (fixed responses, no TTS/STT flake) while still
// exercising the real LLM judge — which is the component #680 is about.
//
// ⚠ WHAT THIS DOES *NOT* PROVE — a control run of these same three cases against
// the PRE-#680 criteria (2026-07-31, gpt-5.6-luna) produced the SAME three
// verdicts: that judge already read the content-free acknowledgement as
// "not on-topic" and the deflection as a "refusal". So #680's gaps are
// specification gaps, not an observed live false-pass, and the tightening buys
// wording that does not depend on a particular judge reading "refusal"
// generously. This test's job is the forward one: it proves the criteria as
// they stand now gate the two failure modes and still admit a good answer.
//
// Live-only, like its audio siblings: it spends judge tokens and talks to the
// LangWatch backend, so CI skips it (see `skipInCi`) and it is run locally.

import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

import { AUDIO_JUDGE_CRITERIA } from "./helpers/audio-judge-criteria";

// Same guard as the audio examples this proves: live judge calls + real
// backend, so it runs locally rather than in CI.
const skipInCi = process.env.CI === "true" || !process.env.OPENAI_API_KEY;

const setId = "audio-judge-criteria-discrimination";

// Never invoked — the conversation is fully scripted — but a scenario needs an
// agent under test in the list.
const noopAgent: AgentAdapter = { role: AgentRole.AGENT, call: async () => "" };

const userAudioTurn = {
  role: "user" as const,
  content:
    "[audio attachment] The user's recorded question: " +
    "\"What's the capital of France?\"",
};

const assistant = (text: string) => ({ role: "assistant" as const, content: text });

const judge = () =>
  scenario.judgeAgent({
    model: openai("gpt-5.6-luna"),
    criteria: [...AUDIO_JUDGE_CRITERIA],
  });

describe("audio example judge criteria — discrimination proof (#680)", () => {
  it.skipIf(skipInCi)(
    "PASSES a response that answers the specific audio question",
    async () => {
      const result = await scenario.run({
        setId,
        name: "audio_criteria_genuine_answer",
        description:
          "The agent heard the recorded question and answered it, noting the " +
          "question arrived as audio.",
        agents: [noopAgent, scenario.userSimulatorAgent(), judge()],
        script: [
          scenario.message(userAudioTurn),
          scenario.message(
            assistant(
              "You asked, in the audio you sent, what the capital of France " +
                "is — it's Paris. Your question came in as an audio recording " +
                "rather than text.",
            ),
          ),
          scenario.judge(),
        ],
        maxTurns: 4,
      });
      expect(
        result.success,
        `a genuine, content-specific answer must PASS. reasoning: ${result.reasoning ?? "<none>"}`,
      ).toBe(true);
    },
    180_000,
  );

  it.skipIf(skipInCi)(
    "FAILS a content-free acknowledgement (the #680 vacuous-green gap)",
    async () => {
      const result = await scenario.run({
        setId,
        name: "audio_criteria_vacuous_acknowledgement",
        description:
          "The agent only acknowledges that audio arrived and never engages " +
          "with what was actually said — the broken-pipeline false pass #680 " +
          "was filed for.",
        agents: [noopAgent, scenario.userSimulatorAgent(), judge()],
        script: [
          scenario.message(userAudioTurn),
          scenario.message(
            assistant(
              "Thanks — I received your audio message and I heard it clearly. " +
                "Your input came through as an audio recording, not as text.",
            ),
          ),
          scenario.judge(),
        ],
        maxTurns: 4,
      });
      expect(
        result.success,
        `a content-free acknowledgement must FAIL criterion 1, but the judge passed it. reasoning: ${result.reasoning ?? "<none>"}`,
      ).toBe(false);
    },
    180_000,
  );

  it.skipIf(skipInCi)(
    "FAILS a polite deflection (the #680 inability-claim gap)",
    async () => {
      const result = await scenario.run({
        setId,
        name: "audio_criteria_polite_deflection",
        description:
          "The agent politely claims it cannot process audio — courteous, " +
          "on-format, and exactly the response #680 says must not pass.",
        agents: [noopAgent, scenario.userSimulatorAgent(), judge()],
        script: [
          scenario.message(userAudioTurn),
          scenario.message(
            assistant(
              "I'm sorry — you sent an audio file, and I'm not able to listen " +
                "to audio. Could you type your question out for me instead?",
            ),
          ),
          scenario.judge(),
        ],
        maxTurns: 4,
      });
      expect(
        result.success,
        `a polite deflection must FAIL criterion 2, but the judge passed it. reasoning: ${result.reasoning ?? "<none>"}`,
      ).toBe(false);
    },
    180_000,
  );
});
