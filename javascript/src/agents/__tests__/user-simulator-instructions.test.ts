/**
 * The user simulator sends its system prompt as AI SDK 7 `instructions`.
 *
 * Covers the user simulator @unit scenarios of
 * `specs/ai-sdk-7-system-prompts.feature`. AI SDK 7 refuses system messages
 * inside `messages` unless the call allows them.
 */
import type { ModelMessage } from "ai";
import { describe, it, expect, vi } from "vitest";

import type { AgentInput } from "../../domain";
import type { InvokeLLMParams } from "../types";
import { userSimulatorAgent } from "../user-simulator-agent";

vi.mock("../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-5-mini", temperature: 0 },
  }),
}));

function makeInput(messages: ModelMessage[]): AgentInput {
  return {
    threadId: "t-instructions",
    messages,
    newMessages: [],
    requestedRole: "User" as AgentInput["requestedRole"],
    scenarioConfig: {
      name: "test",
      description: "A test scenario description",
    } as unknown as AgentInput["scenarioConfig"],
    scenarioState: {} as AgentInput["scenarioState"],
  };
}

/** Stub the simulator's LLM and capture the parameters of its last call. */
function captureLLM(simulator: ReturnType<typeof userSimulatorAgent>) {
  const seen: { params?: InvokeLLMParams } = {};
  (
    simulator as unknown as {
      invokeLLM: (
        params: InvokeLLMParams
      ) => Promise<{ text: string; toolCalls: []; steps: [] }>;
    }
  ).invokeLLM = async (params) => {
    seen.params = params;
    return { text: "Where is my order?", toolCalls: [], steps: [] };
  };
  return seen;
}

describe("given a user simulator agent whose model is stubbed", () => {
  describe("when the simulator produces the user's turn", () => {
    /** @scenario "The user simulator sends its system prompt as instructions" */
    it("carries the system prompt as instructions, not as a message", async () => {
      const simulator = userSimulatorAgent({ systemPrompt: "Be a customer" });
      const seen = captureLLM(simulator);

      await simulator.call(
        makeInput([{ role: "assistant", content: "Hi, how can I help?" }])
      );

      expect(seen.params?.instructions).toBe("Be a customer");
      expect(seen.params?.messages?.some((m) => m.role === "system")).toBe(
        false
      );
    });
  });

  describe("when the transcript holds a system turn added by the script", () => {
    /** @scenario "A system turn added by the script still reaches the user simulator" */
    it("allows system messages and keeps the scripted turn", async () => {
      const simulator = userSimulatorAgent({ systemPrompt: "Be a customer" });
      const seen = captureLLM(simulator);
      const scripted: ModelMessage = {
        role: "system",
        content: "The user is now in a hurry",
      };

      await simulator.call(
        makeInput([
          { role: "assistant", content: "Hi, how can I help?" },
          scripted,
        ])
      );

      expect(seen.params?.allowSystemInMessages).toBe(true);
      expect(seen.params?.messages).toContainEqual(scripted);
    });
  });
});
