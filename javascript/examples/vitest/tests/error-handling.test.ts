import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

/**
 * This test demonstrates how scenario errors are captured and reported
 * in the ScenarioResult.error field.
 */
describe("Scenario Error Handling", () => {
  const errorAgent: AgentAdapter = {
    role: AgentRole.AGENT,
    call: async () => {
      throw new Error("Simulated agent failure");
    },
  };

  it("should capture agent errors in the scenario result", async () => {
    const result = await scenario.run({
      name: "error scenario",
      description: "This scenario is designed to fail due to an agent error.",
      agents: [
        errorAgent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({ criteria: ["Agent should not throw errors"] }),
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Simulated agent failure");
    expect(result.reasoning).toContain("Scenario failed with error");
  });
}); 
