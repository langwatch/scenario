import { createServer, Server } from "http";
import { openai } from "@ai-sdk/openai";
import scenario, { AgentRole, type AgentAdapter } from "@langwatch/scenario";
import { generateText, ModelMessage } from "ai";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Example: Testing a stateful agent that maintains conversation history
 *
 * This demonstrates the thread ID pattern where the server maintains
 * conversation state and the adapter sends only the latest message.
 */

let server: Server;
let serverUrl: string;

// Server-side conversation storage
const conversations = new Map<string, ModelMessage[]>();

beforeAll(async () => {
  // Create stateful HTTP server
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/chat") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const { message, threadId } = JSON.parse(body);

          // Retrieve or initialize conversation history
          const history = conversations.get(threadId) || [];

          // Add user message to history
          const userMessage: ModelMessage = {
            role: "user",
            content: message,
          };
          history.push(userMessage);

          // Generate response with full history
          const result = await generateText({
            model: openai("gpt-4o-mini"),
            messages: [
              {
                role: "system",
                content:
                  "You are a helpful travel assistant. Help users plan their trips and provide information about destinations.",
              },
              ...history,
            ],
            temperature: 0.7,
          });

          // Add assistant response to history
          const assistantMessage: ModelMessage = {
            role: "assistant",
            content: result.text,
          };
          history.push(assistantMessage);

          // Store updated history
          conversations.set(threadId, history);

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
  conversations.clear();
});

describe("Testing Remote Agents - Stateful with Thread ID", () => {
  it("should maintain conversation state across multiple turns", async () => {
    const baseUrl = serverUrl;

    // Stateful adapter - sends only latest message + thread ID
    const statefulAdapter: AgentAdapter = {
      role: AgentRole.AGENT,
      call: async (input) => {
        // Extract only the latest message
        const lastMessage = input.messages[input.messages.length - 1];
        const content =
          typeof lastMessage.content === "string"
            ? lastMessage.content
            : lastMessage.content.find((part) => part.type === "text")?.text ??
              "";

        // Send only the new message + thread ID
        const response = await fetch(`${baseUrl}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: content, // Only the latest message
            threadId: input.threadId, // Server uses this to look up history
          }),
        });
        return (await response.json()).response;
      },
    };

    const result = await scenario.run({
      name: "Multi-turn travel planning",
      description:
        "User asks about Paris, then asks a follow-up question that requires context from the previous answer",
      agents: [
        scenario.userSimulatorAgent({ model: openai("gpt-4o-mini") }),
        statefulAdapter,
        scenario.judgeAgent({
          model: openai("gpt-4o-mini"),
          criteria: [
            "Agent should provide helpful travel information about Paris",
            "Agent should answer follow-up questions with context from previous conversation",
            "Agent should maintain conversational continuity",
          ],
        }),
      ],
      script: [
        scenario.user("Tell me about visiting Paris"),
        scenario.agent(),
        scenario.user("How long should I stay there?"), // Requires context
        scenario.agent(),
        scenario.judge(),
      ],
      setId: "javascript-examples",
    });

    expect(result.success).toBe(true);
  });
});
