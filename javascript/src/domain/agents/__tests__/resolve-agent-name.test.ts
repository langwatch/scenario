// Ref: specs/agent-adapter-names.feature
import { describe, expect, it } from "vitest";
import { AgentAdapter, AgentRole, resolveAgentName } from "..";
import type { AgentInput, AgentReturnTypes } from "..";

class PlainAgent extends AgentAdapter {
  role = AgentRole.AGENT;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return "Hey, how can I help you?";
  }
}

class BlankNameAgent extends PlainAgent {
  name = "   ";
}

class PaddedNameAgent extends PlainAgent {
  name = "  MyAgent  ";
}

describe("resolveAgentName", () => {
  describe("when the adapter sets a name", () => {
    it("reports it without the space around it", () => {
      expect(resolveAgentName(new PaddedNameAgent())).toBe("MyAgent");
    });
  });

  describe("when the name is blank", () => {
    it("reports the class name instead", () => {
      expect(resolveAgentName(new BlankNameAgent())).toBe("BlankNameAgent");
    });
  });

  describe("when the adapter is a plain object", () => {
    it("reports no name, since Object names the language, not the agent", () => {
      const agent: AgentAdapter = {
        role: AgentRole.AGENT,
        call: async () => "Hey, how can I help you?",
      };

      expect(resolveAgentName(agent)).toBeUndefined();
    });
  });

  describe("when the adapter carries a constructor key of its own", () => {
    it("reports no name, since that key is data, not the class", () => {
      const agent = {
        role: AgentRole.AGENT,
        constructor: { name: "Fake" },
        call: async () => "Hey, how can I help you?",
      } as unknown as AgentAdapter;

      expect(resolveAgentName(agent)).toBeUndefined();
    });
  });

  describe("when the adapter is a test double", () => {
    it("reports no name, since every property of it answers a function", () => {
      // The shape a mocking library gives an adapter: `name` reads as a
      // function, not as a string. The examples suite runs adapters like this.
      const agent = new Proxy(
        { role: AgentRole.AGENT },
        {
          get: (target, property) =>
            property in target
              ? target[property as keyof typeof target]
              : () => undefined,
        },
      ) as unknown as AgentAdapter;

      expect(resolveAgentName(agent)).toBeUndefined();
    });
  });
});
