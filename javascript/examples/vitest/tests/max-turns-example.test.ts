/**
 * This test case is used to test the max turns functionality of the scenario library.
 *
 * Max turns can be set at the project level or overridden at the scenario level
 */

import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { mock } from "vitest-mock-extended";
import { describe, expect, it } from "vitest";

const mockAgent = mock<AgentAdapter>({
  role: AgentRole.AGENT,
  call: async () => "Hello, world!",
});

const mockUser = mock<AgentAdapter>({
  role: AgentRole.USER,
  call: async () => "Hello, world!",
});

const mockJudge = mock<AgentAdapter>({
  role: AgentRole.JUDGE,
  call: async () => ({
    success: false,
    messages: [],
    reasoning: "inconclusive",
    metCriteria: [],
    unmetCriteria: [],
  }),
});

describe("when max turns is set at the project level", () => {
  it("the scenario should stop at max turns", async () => {
    const result = await scenario.run({
      name: "max turns example",
      description:
        "This test case is used to test the max turns functionality of the scenario library.",
      agents: [mockAgent, mockUser, mockJudge],
      maxTurns: 20,
      verbose: process.env.VERBOSE === "true",
      setId: "javascript-examples",
    });

    expect(result.messages.length).toBe(40);
    expect(result.success).toBe(false);
  });
});
