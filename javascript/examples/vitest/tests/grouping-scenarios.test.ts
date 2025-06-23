import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

// An adapter for a simple agent that echoes back messages.
const echoAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    const lastMessage = input.messages.at(-1);
    return `You said: ${lastMessage?.content}`;
  },
};

// A dummy user agent that does nothing, but is required by the framework.
const dummyUserAgent: AgentAdapter = {
  role: AgentRole.USER,
  call: async () => "",
};

describe("Grouping Scenarios", () => {
  const setId = "echo-agent-suite";

  it("should succeed when the agent echoes the first message", async () => {
    const result = await scenario.run({
      name: "Echo Test 1",
      description: "The agent should echo back the user's first message.",
      setId: setId, // Assign this scenario to the 'echo-agent-suite'
      agents: [echoAgent, dummyUserAgent],
      script: [
        scenario.user("Hello world!"),
        scenario.agent("You said: Hello world!"),
        scenario.succeed("Agent correctly echoed the message."),
      ],
    });

    expect(result.success).toBe(true);
  });

  it("should succeed when the agent echoes a different message", async () => {
    const result = await scenario.run({
      name: "Echo Test 2",
      description: "The agent should echo back the user's second message.",
      setId: setId, // Assign this scenario to the same 'echo-agent-suite'
      agents: [echoAgent, dummyUserAgent],
      script: [
        scenario.user("This is another test."),
        scenario.agent("You said: This is another test."),
        scenario.succeed("Agent correctly echoed the message."),
      ],
    });

    expect(result.success).toBe(true);
  });
});
