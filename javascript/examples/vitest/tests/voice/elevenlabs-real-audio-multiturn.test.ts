/**
 * REAL voice-in multi-turn on hosted ElevenLabs ConvAI (live e2e harness).
 *
 * A representative hosted-EL customer-support voice flow — a generic multi-turn
 * shape, not any specific user's conversation. Mirrors the stack
 * (`scenario.elevenLabsAgent()` + `UserSimulatorAgent({voice:'openai/nova'})`,
 * multi-turn via `proceed()`) and three script shapes that exercise voice.
 * Content is generic support chatter on purpose: the bug is transport-level
 * (whether real PCM reaches EL's STT on turns 2+), not prompt-dependent.
 *
 * The proof is the REAL-AUDIO streaming path (the adapter's only behavior): the
 * 1.5s trailing silence closes scripted turns on a vanilla agent — no
 * agent-side turn config needed. The assertion is voice-specific and strictly
 * stronger than the older `>=N segments` check (which passes on the broken
 * text-commit path): for the run to count, the adapter must have committed every
 * scripted user turn as REAL PCM (`audioCommitCount >= 2`) and EL must have
 * returned a non-empty STT `user_transcript` — i.e. audio actually reached the
 * agent.
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

/** Build a fresh hosted-EL adapter (real-audio streaming is the only behavior). */
function realAudioAgent(): voice.ElevenLabsAgentAdapter {
  return scenario.elevenLabsAgent({
    agentId: ELEVENLABS_AGENT_ID!,
    apiKey: ELEVENLABS_API_KEY!,
    // The fix: stream REAL PCM for every user turn so EL's STT/VAD/
    // turn-detector run on turns 2+, instead of text-committing them.
  });
}

const SUPPORT_CRITERIA = [
  "the agent stayed on a coherent customer-support thread across every turn",
  "the agent responded to each of the user's turns (no dropped or ignored turn)",
];

/**
 * The live pass criteria. Three independent assertions, all required:
 *  1. EVERY scripted user turn streamed real PCM (`audioCommitCount` ≥ the full
 *     count of scripted user turns) — a dropped/ignored turn fails here, not
 *     just "turns 2+ exist".
 *  2. EL's STT produced a transcript — the audio actually reached the agent.
 *  3. the JUDGE passed (`result.success`) — a coherent multi-turn voice
 *     conversation, the real success criterion, not just bytes on the wire. (The
 *     older weak `>=N segments` check passed on the broken path precisely
 *     because it asserted none of these.)
 */
function assertRealVoiceMultiTurn(
  agent: voice.ElevenLabsAgentAdapter,
  result: ScenarioResult | null,
  label: string,
  minUserTurns: number,
): void {
  expect(result, `${label}: scenario.run() returned no result`).not.toBeNull();
  expect(
    agent.audioCommitCount,
    `${label}: expected >=${minUserTurns} real-audio user commits (one per scripted user turn), got ${agent.audioCommitCount}`,
  ).toBeGreaterThanOrEqual(minUserTurns);
  expect(
    agent.lastUserTranscript,
    `${label}: no STT user_transcript — audio did not reach the agent`,
  ).toBeTruthy();
  expect(
    result!.success,
    `${label}: judge verdict was false — ${result!.reasoning}`,
  ).toBe(true);
  console.log(
    `[real-voice] ${label}: success=${result!.success} audioCommits=${agent.audioCommitCount} ` +
      `lastUserTranscript=${JSON.stringify(agent.lastUserTranscript)} ` +
      `segments=${result!.audio?.segments.length ?? 0}`,
  );
}

describe("hosted-EL real voice-in multi-turn (live)", () => {
  if (!hasHostedKey) {
    it.skip("requires ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID + OPENAI_API_KEY", () => {});
    return;
  }

  // Pattern 1 — proves AUTONOMOUS voice-to-voice: after two scripted voiced turns,
  // an unscripted scenario.user() makes the simulator invent its own line and voice
  // it (because the sim was built with { voice: "openai/nova" }), and the following
  // scenario.agent() flushes that simulator-generated audio to EL, producing a 3rd
  // real-audio commit and a fresh STT user_transcript. Content is generic support
  // chatter on purpose — the proof is transport-level, not prompt-dependent.
  it(
    "pattern 1 — autonomous sim-generated voiced user turn (user→agent→user()→agent)",
    async () => {
      const agent = realAudioAgent();
      const result = await scenario.run({
        name: "real_audio_autonomous_turn",
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
          scenario.user(), // autonomous: the simulator GENERATES its own next line, then voices it
          scenario.agent(), // flushes the sim-generated audio to EL → new audio commit + new STT transcript
          scenario.judge(),
        ],
        maxTurns: 10,
      });
      assertRealVoiceMultiTurn(agent, result, "pattern1", 3);
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
        name: "real_audio_judge",
        description:
          "Representative hosted-EL voice flow, fully scripted: an account " +
          "question, a hours follow-up, and a weekend-support question, judged.",
        agents: [
          agent,
          scenario.userSimulatorAgent({ voice: "openai/nova" }),
          scenario.judgeAgent({ criteria: SUPPORT_CRITERIA }),
        ],
        // All three user turns are ANSWERABLE questions — no "transfer me to a
        // human" ender, which makes EL end/hand off its turn and produce no
        // audio reply (that would fail the judge, not the transport).
        script: [
          scenario.agent(), // EL greeting on connect
          scenario.user("Hi, I have a question about my account balance."),
          scenario.agent(),
          scenario.user("Thanks. What are your support hours this week?"), // turn 2
          scenario.agent(),
          scenario.user("Got it. And what time do you open in the morning?"), // turn 3 (in-domain hours Q — a "weekend support" phrasing made the hosted agent hand off / end its turn)
          scenario.agent(),
          scenario.judge(),
        ],
        maxTurns: 10,
      });
      assertRealVoiceMultiTurn(agent, result, "pattern2", 3);
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
        name: "real_audio_greeting_led",
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
      assertRealVoiceMultiTurn(agent, result, "pattern3", 2);
    },
    240_000,
  );
});
