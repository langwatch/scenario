/**
 * E2E (#705) — a REALTIME user (OpenAI Realtime, role=USER) drives a hosted
 * ElevenLabs ConvAI agent across MULTIPLE turns through the scenario API
 * (`scenario.run()` + scripted `user()` / `agent()`), with REAL audio flowing
 * both ways. Realtime-to-realtime, no TTS on the user side.
 *
 * How the bridge works (no new transport — "the scenario api as is"):
 *  - The realtime user speaks each scripted line itself: the executor routes
 *    `user("...")` to the realtime adapter's `speakUserTurn`, which renders the
 *    line as spoken audio via an OUT-OF-BAND `response.create`
 *    (`conversation:"none"`, `input:[]`, `output_modalities:["audio"]`,
 *    `instructions:"say this verbatim"`). Out-of-band isolation is what keeps
 *    the realtime user from drifting into ANSWERING the line by ~turn 3.
 *  - The spoken audio (+ the model's spoken transcript) is wrapped as an audio
 *    ModelMessage and delivered to the hosted EL agent, which commits the turn
 *    from the transcript (turnCommitMode:"text") and replies in audio.
 *
 * SUCCESS METRIC (Drew's "count utterances"): ≥3 user turns AND ≥3 agent turns
 * where real audio flowed, in one coherent conversation.
 *
 * Env-gated: self-skips without ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID +
 * OPENAI_API_KEY, so CI without the hosted EL secret stays green.
 */

import scenario, { AgentRole, voice, type ScenarioResult } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

const { OPENAI_REALTIME_MODEL } = voice;

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const hasHostedKey = Boolean(ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID && OPENAI_API_KEY);

describe("#705 — realtime user drives hosted EL via scenario.run()", () => {
  it(
    "realtime USER + hosted EL agent: ≥3 user + ≥3 agent audio turns, coherent",
    async () => {
      if (!hasHostedKey) {
        console.log(
          "SKIP: needs ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID + OPENAI_API_KEY",
        );
        return;
      }

      const result: ScenarioResult = await scenario.run({
        name: "realtime_user_drives_hosted_el",
        description:
          "A realtime user (OpenAI Realtime, role=USER) speaks to a hosted " +
          "ElevenLabs ConvAI agent across multiple scripted turns. Real audio " +
          "flows both ways; the conversation is coherent.",
        agents: [
          scenario.elevenLabsAgent({
            agentId: ELEVENLABS_AGENT_ID!,
            apiKey: ELEVENLABS_API_KEY!,
          }),
          // REALTIME user — the model itself speaks, role=USER.
          scenario.openAIRealtimeAgent({
            model: OPENAI_REALTIME_MODEL,
            voice: "marin",
            instructions:
              "You are a customer contacting support about your account. " +
              "Keep each turn to one short sentence.",
            role: AgentRole.USER,
          }),
          scenario.judgeAgent({
            criteria: ["The conversation completed multiple coherent turns"],
          }),
        ],
        // EL sends first_message on connect → lead with agent() so the greeting
        // drains. Then alternate realtime-user / EL-agent for ≥3 each.
        script: [
          scenario.agent(), // EL greeting
          scenario.user("Hi, I have a question about my account."),
          scenario.agent(), // EL reply 1
          scenario.user("Thanks — can you tell me your support hours?"),
          scenario.agent(), // EL reply 2
          scenario.user("Got it. One more — how do I reset my password?"),
          scenario.agent(), // EL reply 3
          scenario.judge(),
        ],
        maxTurns: 12,
      });

      const segs = result.audio?.segments ?? [];
      const userTurns = segs.filter((s) => s.speaker === "user").length;
      const agentTurns = segs.filter((s) => s.speaker === "agent").length;
      // Every counted turn carried real audio bytes (this is "an utterance").
      const userBytes = segs
        .filter((s) => s.speaker === "user")
        .every((s) => (s.audio?.length ?? 0) > 0);
      const agentBytes = segs
        .filter((s) => s.speaker === "agent")
        .every((s) => (s.audio?.length ?? 0) > 0);

      console.log(
        `[#705] segments=${segs.length} userTurns=${userTurns} agentTurns=${agentTurns} ` +
          `success=${result.success}`,
      );
      for (const [i, s] of segs.entries()) {
        console.log(
          `[#705]   seg${i} ${s.speaker} ${(s.endTime - s.startTime).toFixed(2)}s ` +
            `bytes=${s.audio?.length ?? 0} transcript=${JSON.stringify(s.transcript ?? "")}`,
        );
      }

      // SUCCESS METRIC — ≥3 user + ≥3 agent utterances (real audio both ways).
      expect(userTurns, "expected ≥3 realtime-user audio turns").toBeGreaterThanOrEqual(3);
      expect(agentTurns, "expected ≥3 hosted-EL agent audio turns").toBeGreaterThanOrEqual(3);
      expect(userBytes, "a user turn carried no audio bytes").toBe(true);
      expect(agentBytes, "an agent turn carried no audio bytes").toBe(true);
      // Coherence: the judge agreed it was a multi-turn coherent conversation.
      expect(result.success, `judge verdict: ${result.reasoning}`).toBe(true);
    },
    240_000,
  );
});
