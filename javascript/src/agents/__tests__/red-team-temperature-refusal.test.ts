import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { redTeamCrescendo } from "../red-team/red-team-agent";

/**
 * gpt-6 models refuse any temperature but the default while reasoning is
 * on, and @ai-sdk/openai does not know gpt-6 names as reasoning models, so
 * the agent's 0.7 default reaches the provider. The call must be re-sent
 * without it instead of failing the run.
 */
function refusingTemperatureModel() {
  const temperatures: Array<number | undefined> = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      temperatures.push(options.temperature);
      if (options.temperature !== undefined) {
        throw new Error(
          "Unsupported parameter: 'temperature' is not supported with this model."
        );
      }
      return {
        content: [{ type: "text", text: "attack message" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      } as never;
    },
  });
  return { model, temperatures };
}

describe("RedTeamAgent on a model that refuses a temperature", () => {
  it("re-sends the attacker call without it and remembers that", async () => {
    const { model, temperatures } = refusingTemperatureModel();
    const agent = redTeamCrescendo({ target: "t", attackPlan: "plan", model });
    const internal = agent as unknown as {
      attackerHistory: Array<{ role: string; content: string }>;
      callAttackerLLM(): Promise<string>;
    };
    internal.attackerHistory = [{ role: "system", content: "prompt" }];

    expect(await internal.callAttackerLLM()).toBe("attack message");
    expect(await internal.callAttackerLLM()).toBe("attack message");

    expect(temperatures).toEqual([0.7, undefined, undefined]);
  });
});
