import { createServer, Server } from "http";
import { openai } from "@ai-sdk/openai";
import scenario, { AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText } from "ai";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Example: Testing an agent via HTTP endpoint with JSON responses
 *
 * This test demonstrates the most common pattern for testing remote agents:
 * creating an adapter that makes HTTP POST requests and parses JSON responses.
 *
 * The server uses a real LLM (OpenAI GPT-4o-mini) to generate responses.
 */

let server: Server;
let serverUrl: string;

beforeAll(async () => {
  // Create HTTP server with real LLM-powered agent
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/chat") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const { message } = JSON.parse(body);

          // Use real LLM to generate response
          const result = await generateText({
            model: openai("gpt-4o-mini"),
            messages: [
              {
                role: "system",
                /**
                 * Simple system prompt to make the agent pretend like it has access to a weather API and make up the weather so the tests pass.
                 */
                content:
                  "You are a helpful weather assistant. Provide brief, friendly responses about weather. Pretend like you have access to a weather API and make up the weather.",
              },
              {
                role: "user",
                content: message,
              },
            ],
            temperature: 0.7,
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ response: result.text }));
        } catch (error) {
          console.error(error);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" ? address?.port : 3000;
      serverUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe("Testing Remote Agents - JSON Response", () => {
  it("should test agent via HTTP endpoint with JSON response", async () => {
    // Base URL for your agent endpoint
    const baseUrl = serverUrl;

    // Create adapter that calls agent via HTTP
    const jsonAgentAdapter: AgentAdapter = {
      role: AgentRole.AGENT,
      call: async (input) => {
        // Extract the most recent user message from the conversation
        const lastMessage = input.messages[input.messages.length - 1];

        // Handle both string content and multipart content (images, files, etc.)
        const content =
          typeof lastMessage.content === "string"
            ? lastMessage.content
            : lastMessage.content.find((part) => part.type === "text")?.text ??
              "";

        // Make HTTP POST request to your agent's endpoint
        const response = await fetch(`${baseUrl}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: content }),
        });

        // Parse JSON response and return the agent's message
        const result = await response.json();
        return result.response; // Adjust field name to match your API
      },
    };

    // Run scenario test
    const result = await scenario.run({
      name: "Weather inquiry via HTTP",
      description: "User asks about weather through HTTP API",
      agents: [
        scenario.userSimulatorAgent({ model: openai("gpt-4o-mini") }),
        jsonAgentAdapter,
        scenario.judgeAgent({ model: openai("gpt-4o-mini") }),
      ],
      script: [
        scenario.user("What's the weather like today in Paris? Be specific."),
        scenario.agent(),
        scenario.user(),
        scenario.agent(),
        scenario.judge({
          criteria: [
            "Agent should respond helpfully to weather questions",
            "Agent should provide specific weather information",
          ],
        }),
      ],
      setId: "javascript-examples",
    });

    expect(result.success).toBe(true);
  });
});
