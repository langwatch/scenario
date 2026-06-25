/**
 * #705 — REAL voice-in multi-turn on hosted ElevenLabs ConvAI (live e2e harness).
 *
 * REPRESENTATIVE RECONSTRUCTION of a Vinny-style hosted-EL voice flow — NOT the
 * customer's literal scenario. Mirrors their stack (`scenario.elevenLabsAgent()`
 * + `UserSimulatorAgent({voice:'openai/nova'})`, multi-turn via `proceed()`) and
 * the three script shapes they reported broken for voice. Content is generic
 * support chatter on purpose: the #705 bug is transport-level (whether real PCM
 * reaches EL's STT on turns 2+), not prompt-dependent.
 *
 * The proof is the REAL-AUDIO commit mode (`turnCommitMode:"audio"`, issue #705)
 * paired with an agent provisioned for aggressive turn-taking (see
 * scripts/provision_elevenlabs_agent.py). The assertion is voice-specific and
 * strictly stronger than #596's `>=N segments` (which passes on the broken
 * text-commit path): for the run to count, the adapter must have committed every
 * scripted user turn as REAL PCM (`audioCommitCount >= 2`), injected NO
 * `user_message` text (`textCommitCount === 0`), and EL must have returned a
 * non-empty STT `user_transcript` — i.e. audio actually reached the agent.
 *
 * Env-gated on ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID + OPENAI_API_KEY; self-
 * skips otherwise. Runs live via the `javascript-voice-integration.yml`
 * workflow_dispatch (AC5: 3 consecutive clean runs).
 */
import scenario, { voice, type ScenarioResult } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const hasHostedKey = Boolean(ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID && OPENAI_API_KEY);

/** Build a fresh hosted-EL adapter in the #705 real-audio commit mode. */
function realAudioAgent(): voice.ElevenLabsAgentAdapter {
  return scenario.elevenLabsAgent({
    agentId: ELEVENLABS_AGENT_ID!,
    apiKey: ELEVENLABS_API_KEY!,
    // The #705 fix: stream REAL PCM for every user turn so EL's STT/VAD/
    // turn-detector run on turns 2+, instead of text-committing them.
    turnCommitMode: "audio",
  });
}

const SUPPORT_CRITERIA = [
  "the agent stayed on a coherent customer-support thread across every turn",
  "the agent responded to each of the user's turns (no dropped or ignored turn)",
];

/**
 * The #705 voice-specific, STT-driven assertion (AC4) applied to a LIVE run.
 * `result.success` (the judge) is informative; THIS is what proves real audio
 * reached the agent on turns 2+.
 */
function assertRealVoiceMultiTurn(
  agent: voice.ElevenLabsAgentAdapter,
  result: ScenarioResult | null,
  label: string,
): void {
  expect(result, `${label}: scenario.run() returned no result`).not.toBeNull();
  // Every scripted user turn went out as REAL PCM (>= 2 ⇒ turns 2+ included) …
  expect(
    agent.audioCommitCount,
    `${label}: expected >=2 real-audio user commits (turns 2+ as PCM), got ${agent.audioCommitCount}`,
  ).toBeGreaterThanOrEqual(2);
  // … and NONE were text-injected (which would discard the audio / bypass STT).
  expect(
    agent.textCommitCount,
    `${label}: a user turn was text-committed — audio bypassed STT (the #705 bug)`,
  ).toBe(0);
  // … and EL produced an STT transcript, i.e. the audio actually reached it.
  expect(
    agent.lastUserTranscript,
    `${label}: no STT user_transcript — audio did not reach the agent`,
  ).toBeTruthy();
  console.log(
    `[#705] ${label}: success=${result!.success} audioCommits=${agent.audioCommitCount} ` +
      `textCommits=${agent.textCommitCount} lastUserTranscript=${JSON.stringify(agent.lastUserTranscript)} ` +
      `segments=${result!.audio?.segments.length ?? 0}`,
  );
}

describe("#705 hosted-EL real voice-in multi-turn (live)", () => {
  if (!hasHostedKey) {
    it.skip("requires ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID + OPENAI_API_KEY", () => {});
    return;
  }

  // Pattern 1 — user → agent → proceed(): the customer's autonomous-continuation
  // shape. Lead with agent() to drain EL's on-connect greeting, two scripted
  // user turns (exercises the turn-2 bug), then hand off to proceed().
  it(
    "pattern 1 — user→agent→proceed() autonomous multi-turn",
    async () => {
      const agent = realAudioAgent();
      const result = await scenario.run({
        name: "705_real_audio_proceed",
        description:
          "Representative hosted-EL voice flow: caller asks an account question, " +
          "a follow-up, then the simulation proceeds autonomously.",
        agents: [
          agent,
          scenario.userSimulatorAgent({ voice: "openai/nova" }),
          scenario.judgeAgent({ criteria: SUPPORT_CRITERIA }),
        ],
        script: [
          scenario.agent(), // EL greeting on connect
          scenario.user("Hi, I have a question about my account balance."),
          scenario.agent(),
          scenario.user("Thanks. What are your support hours this week?"), // turn 2
          scenario.agent(),
          scenario.proceed(1), // exercises the proceed() path Vinny reported broken
          scenario.judge(),
        ],
        maxTurns: 10,
      });
      assertRealVoiceMultiTurn(agent, result, "pattern1");
    },
    240_000,
  );

  // Pattern 2 — user → agent → … → judge(): a fully-scripted multi-turn ending
  // in a judgment. Three scripted user turns so turns 2 AND 3 are real audio.
  it(
    "pattern 2 — user→agent→judge() scripted multi-turn",
    async () => {
      const agent = realAudioAgent();
      const result = await scenario.run({
        name: "705_real_audio_judge",
        description:
          "Representative hosted-EL voice flow, fully scripted: an account " +
          "question, a hours follow-up, and an escalation request, then judged.",
        agents: [
          agent,
          scenario.userSimulatorAgent({ voice: "openai/nova" }),
          scenario.judgeAgent({ criteria: SUPPORT_CRITERIA }),
        ],
        script: [
          scenario.agent(), // EL greeting on connect
          scenario.user("Hi, I have a question about my account balance."),
          scenario.agent(),
          scenario.user("Thanks. What are your support hours this week?"), // turn 2
          scenario.agent(),
          scenario.user("Okay — can you connect me to a human agent?"), // turn 3
          scenario.agent(),
          scenario.judge(),
        ],
        maxTurns: 10,
      });
      assertRealVoiceMultiTurn(agent, result, "pattern2");
    },
    240_000,
  );

  // Pattern 3 — agent → user → agent → … → judge(): explicitly agent-led (the
  // greeting is the first turn), then alternating real-audio user turns.
  it(
    "pattern 3 — agent→user→agent→judge() greeting-led multi-turn",
    async () => {
      const agent = realAudioAgent();
      const result = await scenario.run({
        name: "705_real_audio_greeting_led",
        description:
          "Representative hosted-EL voice flow, greeting-led: EL opens, the " +
          "caller asks two questions across turns, then the run is judged.",
        agents: [
          agent,
          scenario.userSimulatorAgent({ voice: "openai/nova" }),
          scenario.judgeAgent({ criteria: SUPPORT_CRITERIA }),
        ],
        script: [
          scenario.agent(), // EL greeting leads
          scenario.user("Hello! I'd like to check the balance on my account."),
          scenario.agent(),
          scenario.user("Got it — and what time do you close today?"), // turn 2
          scenario.agent(),
          scenario.judge(),
        ],
        maxTurns: 10,
      });
      assertRealVoiceMultiTurn(agent, result, "pattern3");
    },
    240_000,
  );
});
