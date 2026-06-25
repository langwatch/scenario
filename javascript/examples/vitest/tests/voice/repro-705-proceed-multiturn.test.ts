// Repro + fix proof for https://github.com/langwatch/scenario/issues/705 —
// `scenario.proceed(N)` should drive N voiced multi-turn turns for a hosted
// ElevenLabs agent, exactly like an explicit user()/agent() script does.
//
// Before the fix, a user-simulator turn GENERATED inside the proceed() loop was
// broadcast as TEXT (not audio), so the hosted EL adapter never committed the
// user turn and the next agent receive timed out — collapsing proceed(N) to a
// single voiced exchange (only the scripted opener). The fix voiceifies the
// generated user turn into audio in callAgent, parity with the scripted
// user("text") path.
//
// SUCCESS METRIC (Drew's "count utterances"): count audio segments by speaker.
// A real multi-turn voiced conversation via proceed produces >=3 user audio
// turns AND >=3 agent replies.
//
// NOTE on the judge: a JudgeAgent in the agents list runs every proceed() turn
// (USER -> AGENT -> JUDGE), and proceed() returns the instant the judge yields a
// final ScenarioResult. With lenient criteria the judge concludes after turn 1,
// which masks proceed's turn-driving with an early exit. To prove the
// turn-driving itself, the primary scenario omits the judge so `maxTurns` is the
// only bound and every proceed turn runs — the exact user-sim -> voiceify -> EL
// path the #705 fix repairs. A second scenario keeps the judge to show the full
// "scenario API as is" shape still passes.

import scenario, { type ScenarioResult } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

import { saveDemoRecording } from "./helpers/save-demo-recording";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const hasHostedKey = Boolean(
  ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID && OPENAI_API_KEY,
);

function countSpeakers(result: ScenarioResult): { user: number; agent: number } {
  const segments = result.audio?.segments ?? [];
  return {
    user: segments.filter((s) => s.speaker === "user").length,
    agent: segments.filter((s) => s.speaker === "agent").length,
  };
}

describe("repro #705 — proceed(N) drives multi-turn voice on hosted EL", () => {
  it(
    "proceed(4) drives >=3 voiced user turns + >=3 agent replies (hosted EL, no judge)",
    async () => {
      if (!hasHostedKey) {
        console.log("SKIP: no hosted creds (ELEVENLABS_API_KEY/AGENT_ID + OPENAI_API_KEY)");
        return;
      }

      let result: ScenarioResult | null = null;
      let caught: unknown = null;
      const turnsSeen: number[] = [];

      try {
        result = await scenario.run({
          name: "repro_705_proceed_multiturn",
          description:
            "Voiced multi-turn conversation driven by scenario.proceed(4) against " +
            "a live hosted ElevenLabs ConvAI agent. The user simulator speaks " +
            "(openai/nova TTS), the hosted agent replies over the live WebSocket, " +
            "repeated for multiple turns. The user is calling about their account " +
            "and asks a series of follow-up questions about their account.",
          agents: [
            scenario.elevenLabsAgent({
              agentId: ELEVENLABS_AGENT_ID!,
              apiKey: ELEVENLABS_API_KEY!,
            }),
            scenario.userSimulatorAgent({ voice: "openai/nova" }),
          ],
          // The "scenario API as is should work" path: lead with the greeting +
          // ONE scripted user opener, then let proceed(4) auto-drive the rest of
          // the multi-turn voiced conversation. proceed() must re-engage the
          // voiced user-sim each turn (the #705 fix). No judge -> maxTurns bounds
          // it, so every proceed turn runs and we can count utterances cleanly.
          script: [
            scenario.agent(), // greeting drains
            scenario.user("Hi, I have a question about my account balance."),
            scenario.proceed(
              4,
              (state) => {
                // onTurn fires once per turn; the state does not expose audio,
                // so we only record the turn number to prove proceed advanced
                // through multiple turns (utterance counts come from the final
                // recording below).
                turnsSeen.push(state.currentTurn);
              },
            ),
          ],
          maxTurns: 12,
        });
      } catch (e) {
        caught = e;
      }

      if (caught) {
        console.log("[repro#705] THREW:", (caught as Error)?.message ?? caught);
      }
      console.log("[repro#705] proceed turns advanced:", JSON.stringify(turnsSeen));

      expect(caught, "proceed(N) multi-turn voice threw").toBeNull();
      expect(result, "scenario.run() returned no result").not.toBeNull();
      expect(result!.audio, "result.audio missing").toBeDefined();

      const { user: userTurns, agent: agentTurns } = countSpeakers(result!);
      const recordingDir = saveDemoRecording(result!.audio, "elevenlabs_proceed_705");

      // COUNT UTTERANCES — the load-bearing empirical proof for #705.
      console.log(
        `[repro#705] UTTERANCE COUNTS → user audio turns=${userTurns}, ` +
          `agent replies=${agentTurns}, total segments=${result!.audio!.segments.length}, ` +
          `recording=${recordingDir}`,
      );

      // proceed(4) after the scripted opener must yield a real multi-turn voiced
      // conversation: >=3 user audio turns AND >=3 agent replies. The pre-fix
      // path collapses to 1 voiced user turn (the scripted opener) because the
      // generated proceed turns are broadcast as text and never commit.
      expect(
        userTurns,
        `expected >=3 voiced user turns from proceed(4); got ${userTurns} ` +
          "(pre-fix: only the scripted opener voices)",
      ).toBeGreaterThanOrEqual(3);
      expect(
        agentTurns,
        `expected >=3 agent replies; got ${agentTurns}`,
      ).toBeGreaterThanOrEqual(3);
    },
    300_000,
  );

  it(
    "proceed(3) + judge() completes the full 'scenario API as is' shape (hosted EL)",
    async () => {
      if (!hasHostedKey) {
        console.log("SKIP: no hosted creds");
        return;
      }

      let result: ScenarioResult | null = null;
      let caught: unknown = null;

      try {
        result = await scenario.run({
          name: "repro_705_proceed_multiturn_judged",
          description:
            "The exact 'scenario API as is' shape from #705: greeting + scripted " +
            "opener + proceed(3) + judge(), voiced user-sim vs hosted ElevenLabs.",
          agents: [
            scenario.elevenLabsAgent({
              agentId: ELEVENLABS_AGENT_ID!,
              apiKey: ELEVENLABS_API_KEY!,
            }),
            scenario.userSimulatorAgent({ voice: "openai/nova" }),
            scenario.judgeAgent({
              criteria: [
                "The conversation completed multiple coherent voiced turns",
                "The agent and user exchanged audio turns via the live WebSocket",
              ],
            }),
          ],
          script: [
            scenario.agent(),
            scenario.user("Hi, I have a question about my account balance."),
            scenario.proceed(3),
            scenario.judge(),
          ],
          maxTurns: 12,
        });
      } catch (e) {
        caught = e;
      }

      if (caught) {
        console.log("[repro#705 judged] THREW:", (caught as Error)?.message ?? caught);
      }

      expect(caught, "judged proceed shape threw").toBeNull();
      expect(result, "scenario.run() returned no result").not.toBeNull();

      const { user: userTurns, agent: agentTurns } = countSpeakers(result!);
      console.log(
        `[repro#705 judged] UTTERANCE COUNTS → user audio turns=${userTurns}, ` +
          `agent replies=${agentTurns}, success=${result!.success}`,
      );
      // The judged shape must not throw and must produce audio; the early-judge
      // exit is acceptable here (the no-judge case above carries the turn-count
      // proof). At minimum the scripted opener voices + the agent replies.
      expect(result!.audio?.segments.length ?? 0, "no audio segments").toBeGreaterThan(0);
    },
    300_000,
  );
});
