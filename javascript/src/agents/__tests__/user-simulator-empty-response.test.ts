/**
 * The user simulator retries an empty model answer.
 *
 * Covers the @unit scenarios of `specs/user-simulator-empty-response.feature`.
 * A model that answers with empty text used to fail the turn on the spot,
 * which reads in the UI as the simulator going silent mid-conversation. The
 * retry lives in the simulator rather than in the shared LLM invoker because
 * the judge answers with tool calls, where empty text is normal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { AgentInput } from "../../domain";
import { userSimulatorAgent } from "../user-simulator-agent";

vi.mock("../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-5-mini", temperature: 0 },
  }),
}));

function makeInput(): AgentInput {
  return {
    threadId: "t-empty-response",
    messages: [{ role: "assistant", content: "Hi there, how can I help?" }],
    newMessages: [],
    requestedRole: "User" as AgentInput["requestedRole"],
    scenarioConfig: {
      name: "test",
      description: "A test scenario description",
    } as unknown as AgentInput["scenarioConfig"],
    scenarioState: {} as AgentInput["scenarioState"],
  };
}

/** Stub the simulator's LLM with one scripted answer text per call. */
function stubLLM(
  simulator: ReturnType<typeof userSimulatorAgent>,
  texts: string[]
) {
  const state = { calls: 0 };
  (
    simulator as unknown as {
      invokeLLM: () => Promise<{ text: string; toolCalls: []; steps: [] }>;
    }
  ).invokeLLM = async () => {
    const text = texts[state.calls] ?? texts[texts.length - 1] ?? "";
    state.calls += 1;
    return { text, toolCalls: [], steps: [] };
  };
  return state;
}

describe("given a user simulator agent whose model is stubbed", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("when the model answers with empty text once", () => {
    /** @scenario "An empty model answer is retried before the run fails" */
    it("asks again and returns the message from the second answer", async () => {
      const simulator = userSimulatorAgent({});
      const state = stubLLM(simulator, ["", "Where is my order?"]);

      const message = await simulator.call(makeInput());

      expect(state.calls).toBe(2);
      expect(message).toEqual({
        role: "user",
        content: "Where is my order?",
      });
    });
  });

  describe("when the model answers with empty text every time", () => {
    /** @scenario "A third empty answer still fails the turn with the empty-response message" */
    it("fails the turn with the empty-response message after three attempts", async () => {
      const simulator = userSimulatorAgent({});
      const state = stubLLM(simulator, [""]);

      await expect(simulator.call(makeInput())).rejects.toThrow(
        "No response content from LLM"
      );
      expect(state.calls).toBe(3);
    });
  });
});
