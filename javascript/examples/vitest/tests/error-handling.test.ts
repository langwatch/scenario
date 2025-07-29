import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

/**
 * This test demonstrates how scenario errors are thrown and caught
 * by vitest when agents fail.
 */
describe("Scenario Error Handling", () => {
  const errorAgent: AgentAdapter = {
    role: AgentRole.AGENT,
    call: async () => {
      throw new Error("Simulated agent failure");
    },
  };

  it("should throw when agent errors occur", async () => {
    await expect(() =>
      scenario.run({
        name: "error scenario",
        description: "This scenario is designed to fail due to an agent error.",
        agents: [
          errorAgent,
          scenario.userSimulatorAgent(),
          scenario.judgeAgent({ criteria: ["Agent should not throw errors"] }),
        ],
        setId: "javascript-examples",
      })
    ).rejects.toThrow("Simulated agent failure");
  });
});
