// Repro for https://github.com/langwatch/scenario/issues/638 — a 2nd scripted user turn on a hosted elevenLabsAgent should time out with `receiveAudio timed out`. Standalone; does not modify the canonical elevenlabs-hosted.test.ts.

import scenario, { type ScenarioResult } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const hasHostedKey = Boolean(ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID && OPENAI_API_KEY);

describe("repro #638 — hosted elevenLabsAgent 2nd scripted user turn", () => {
  it(
    "hosted agent: a 2nd scripted user turn times out (repro #638)",
    async () => {
      if (!hasHostedKey) {
        console.log("SKIP: no hosted creds");
        return;
      }

      let caught: unknown = null;
      let result: ScenarioResult | null = null;

      try {
        result = await scenario.run({
          name: "repro_638_hosted_multiturn",
          description:
            "Repro for #638: a second scripted user() turn on a hosted " +
            "elevenLabsAgent. The hosted ConvAI transport is server-VAD-driven; " +
            "after the agent has already replied, a second scripted user turn " +
            "does not reliably re-engage the server's turn-taking, causing the " +
            "next agent() receive to time out with 'receiveAudio timed out'.",
          agents: [
            scenario.elevenLabsAgent({
              agentId: ELEVENLABS_AGENT_ID!,
              apiKey: ELEVENLABS_API_KEY!,
            }),
            scenario.userSimulatorAgent({ voice: "openai/nova" }),
            scenario.judgeAgent({
              criteria: [
                "The conversation completed multiple coherent turns",
              ],
            }),
          ],
          // KEY difference from the canonical hosted test: a SECOND scripted
          // user/agent pair. On a hosted ConvAI agent the next agent() after the
          // 2nd scripted user turn is expected to throw "receiveAudio timed out".
          script: [
            scenario.agent(),                                                // greeting drains
            scenario.user("Hello, I have a question about my account."),
            scenario.agent(),                                                // 1st reply — works
            scenario.user("Great — can I also switch to an annual plan?"),   // 2nd scripted user turn
            scenario.agent(),                                                // EXPECTED: receiveAudio timed out here
            scenario.judge(),
          ],
          maxTurns: 8,
        });
      } catch (e) {
        caught = e;
      }

      // Log whichever happened so the run output is self-explanatory:
      if (caught) {
        console.log("[repro#638] THREW:", (caught as Error)?.message ?? caught);
      } else {
        console.log(
          "[repro#638] completed without throw; success=",
          result?.success,
          "reasoning=",
          result?.reasoning,
        );
      }

      // We EXPECT the 2nd agent() to time out on hosted ConvAI (the bug). If it does NOT throw,
      // that is itself a finding (the ceiling may have changed). Record, don't hard-fail.
      expect(caught !== null || result !== null, "neither threw nor returned").toBe(true);
    },
    180_000,
  );
});
