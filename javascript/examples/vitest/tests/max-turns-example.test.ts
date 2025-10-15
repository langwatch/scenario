/**
 * This test case is used to test the max turns functionality of the scenario library.
 *
 * Max turns can be set at the project level or overridden at the scenario level
 */

import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";

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
  call: async () => null,
});

describe("when max turns is not set", () => {
  it("the scenario should stop at the default max turns worth of messages", async () => {
    const result = await scenario.run({
      name: "max turns example",
      description:
        "This test case is used to test the max turns functionality of the scenario library.",
      agents: [mockAgent, mockUser, mockJudge],
      setId: "javascript-examples",
    });

    expect(result.messages.length).toBe(20);
  });
});

describe("when max turns is set to 20", () => {
  it("the scenario should stop at 40 messages", async () => {
    const result = await scenario.run({
      name: "max turns example",
      description:
        "This test case is used to test the max turns functionality of the scenario library.",
      agents: [mockAgent, mockUser, mockJudge],
      setId: "javascript-examples",
      maxTurns: 20,
    });

    expect(result.messages.length).toBe(40);
  });
});
