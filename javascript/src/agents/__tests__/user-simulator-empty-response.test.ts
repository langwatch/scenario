import { describe, expect, it, vi } from "vitest";

import type { AgentInput } from "../../domain";
import { userSimulatorAgent } from "../user-simulator-agent";

vi.mock("../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-4.1-mini", temperature: 0 },
  }),
}));

const input = {
  threadId: "empty-response-thread",
  messages: [],
  newMessages: [],
  requestedRole: "User",
  scenarioConfig: {
    name: "test",
    description: "A test scenario",
  } as AgentInput["scenarioConfig"],
  scenarioState: {} as AgentInput["scenarioState"],
} as AgentInput;

describe("UserSimulatorAgent empty responses", () => {
  it("retries one empty completion", async () => {
    const sim = userSimulatorAgent({});
    const invokeLLM = vi
      .fn()
      .mockResolvedValueOnce({ text: "", toolCalls: [], steps: [] })
      .mockResolvedValueOnce({ text: "continue", toolCalls: [], steps: [] });
    sim.invokeLLM = invokeLLM;

    await expect(sim.call(input)).resolves.toMatchObject({
      role: "user",
      content: "continue",
    });
    expect(invokeLLM).toHaveBeenCalledTimes(2);
  });

  it("keeps the existing error after two empty completions", async () => {
    const sim = userSimulatorAgent({});
    const invokeLLM = vi.fn().mockResolvedValue({
      text: "",
      toolCalls: [],
      steps: [],
    });
    sim.invokeLLM = invokeLLM;

    await expect(sim.call(input)).rejects.toThrow(
      "No response content from LLM"
    );
    expect(invokeLLM).toHaveBeenCalledTimes(2);
  });
});
