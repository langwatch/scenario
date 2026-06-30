// EL-FREE proof that the voice coherence criterion DISCRIMINATES.
//
// A judge gate is only meaningful if it FAILS the bad case. A criterion that
// always returns success is useless theatre. This test proves
// AGENTS_HEARD_EACH_OTHER actually gates: it must PASS a coherent conversation
// AND FAIL one where the agent talks past the user.
//
// It scripts BOTH sides with fixed text via scenario.message() and judges with
// the OpenAI judge only — NO hosted ElevenLabs — so it is reliable and not
// subject to EL's ambient no-audio flakiness (#708). The live voice path layers
// an STT pre-pass (src/voice/judge-stt.ts) over this exact same judge, so
// proving the criterion discriminates here proves the voice gate's core.

import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

import { AGENTS_HEARD_EACH_OTHER } from "./helpers/judge-criteria";

const RUN = Boolean(process.env.OPENAI_API_KEY);

// Never invoked (the conversation is fully scripted via message()), but a
// scenario needs an agent under test in the list.
const noopAgent: AgentAdapter = { role: AgentRole.AGENT, call: async () => "" };

const userMsg = (text: string) => ({ role: "user" as const, content: text });
const assistantMsg = (text: string) => ({ role: "assistant" as const, content: text });

describe("voice judge coherence criterion — EL-free discrimination proof", () => {
  it.skipIf(!RUN)(
    "PASSES a coherent conversation (agent addresses what the user actually said)",
    async () => {
      const result = await scenario.run({
        name: "coherence_criterion_coherent",
        description:
          "A coherent banking-support conversation: the agent answers each " +
          "question on-topic, proving it heard the user.",
        agents: [
          noopAgent,
          scenario.userSimulatorAgent(),
          scenario.judgeAgent({ criteria: [AGENTS_HEARD_EACH_OTHER] }),
        ],
        script: [
          scenario.message(userMsg("What's my current account balance?")),
          scenario.message(
            assistantMsg(
              "I can't view your balance directly for security reasons — please " +
                "log into your online banking or app to see your current balance.",
            ),
          ),
          scenario.message(userMsg("Okay, and how do I see my last three transactions?")),
          scenario.message(
            assistantMsg(
              "In the same app, open your account and tap Transaction history; " +
                "your last three transactions appear at the top.",
            ),
          ),
          scenario.judge(),
        ],
        maxTurns: 6,
      });
      console.log(
        `[coherence-proof COHERENT] success=${result.success} reasoning=${result.reasoning ?? "<none>"}`,
      );
      expect(
        result.success,
        `coherent conversation should PASS the coherence gate. reasoning: ${result.reasoning ?? "<none>"}`,
      ).toBe(true);
    },
    120_000,
  );

  it.skipIf(!RUN)(
    "FAILS an incoherent conversation (agent talks past the user — non-sequiturs)",
    async () => {
      const result = await scenario.run({
        name: "coherence_criterion_incoherent",
        description:
          "An INCOHERENT conversation: the agent's replies are non-sequiturs " +
          "unrelated to what the user asked — the agents are NOT hearing each other.",
        agents: [
          noopAgent,
          scenario.userSimulatorAgent(),
          scenario.judgeAgent({ criteria: [AGENTS_HEARD_EACH_OTHER] }),
        ],
        script: [
          scenario.message(userMsg("What's my current account balance?")),
          scenario.message(
            assistantMsg(
              "The weather today is sunny with a high near 24 degrees and a " +
                "light breeze from the west.",
            ),
          ),
          scenario.message(userMsg("Okay, and how do I see my last three transactions?")),
          scenario.message(
            assistantMsg(
              "My favorite hobby is hiking, and on weekends I usually bake " +
                "sourdough bread.",
            ),
          ),
          scenario.judge(),
        ],
        maxTurns: 6,
      });
      console.log(
        `[coherence-proof INCOHERENT] success=${result.success} reasoning=${result.reasoning ?? "<none>"}`,
      );
      expect(
        result.success,
        `incoherent conversation should FAIL the coherence gate, but the judge passed it. reasoning: ${result.reasoning ?? "<none>"}`,
      ).toBe(false);
    },
    120_000,
  );
});
