import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText } from "ai";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server } from "http";
import { json } from "stream/consumers";

/**
 * Creates a server that listens on port 3000 and responds to requests with a generated text response.
 * @returns A server that listens on port 3000 and responds to requests with a generated text response.
 */
const myAgentServer = () => {
  const server = createServer(async (req, res) => {
    const data: any = await json(req);
    // Generate a response using the OpenAI API or how ever you want to generate a response
    const response = await generateText({
      model: openai("gpt-4.1"),
      messages: data.messages,
    });
    res.end(JSON.stringify({ text: response.text }, null, 2));
  });

  return server;
};

/**
 * HTTP Agent Wrapper that communicates with an AI agent through HTTP requests.
 * This demonstrates how to wrap an existing HTTP-based AI service as a scenario agent.
 */
const httpAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    console.log("Agent received input");
    // Make HTTP request to local server with only the messages
    // We serialize only messages to avoid circular references and keep payload minimal
    const response = await fetch("http://localhost:3000", {
      method: "POST",
      body: JSON.stringify({ messages: input.messages }),
    });
    const data = await response.json();
    return data.text;
  },
};

/**
 * Test suite demonstrating how to test an HTTP-wrapped AI agent.
 * Sets up a local HTTP server that acts as the AI service backend.
 */
describe("Fetch Agent Wrapper Example", () => {
  let server: Server;

  /**
   * Set up a local HTTP server that simulates an AI service.
   * The server receives messages and uses OpenAI to generate responses.
   */
  beforeAll(async () => {
    server = myAgentServer();
    server.listen(3000);
  });

  /**
   * Clean up the HTTP server after tests complete.
   */
  afterAll(async () => {
    server.close();
  });

  /**
   * Test that verifies the HTTP agent wrapper works correctly in a scenario.
   * The scenario simulates a simple conversation where the user greets the agent
   * and expects two responses before succeeding.
   */
  it("should successfully run a scenario with HTTP agent wrapper", async () => {
    const result = await scenario.run({
      name: "Simple HTTP Agent Wrapper Example",
      description:
        "The user simply wants you to respond twice, then that's enough.",
      agents: [httpAgent, scenario.userSimulatorAgent()],
      script: [
        scenario.user("Hello"), // User starts with greeting
        scenario.proceed(2), // Allow 2 conversation turns
        scenario.succeed(), // Mark scenario as successful
      ],
      setId: "javascript-examples",
    });

    expect(result.success).toBe(true);
  });
});
