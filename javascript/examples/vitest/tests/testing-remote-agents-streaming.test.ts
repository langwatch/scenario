import { createServer, Server } from "http";
import { openai } from "@ai-sdk/openai";
import scenario, { AgentAdapter, AgentRole } from "@langwatch/scenario";
import { streamText } from "ai";
import { describe, it, beforeAll, afterAll } from "vitest";
import { expectResultsSuccess } from "./helpers/expect-results-success";

/**
 * Example: Testing an agent that returns streaming responses
 *
 * This test demonstrates handling agents that stream their responses in chunks
 * rather than returning a complete message at once. The server uses real LLM streaming.
 */

let server: Server;
let serverUrl: string;

beforeAll(async () => {
  // Create server that streams LLM responses
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/chat/stream") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const { messages } = JSON.parse(body);

          // Determine last user message
          const lastMsg = messages[messages.length - 1];
          const content =
            typeof lastMsg.content === "string"
              ? lastMsg.content
              : lastMsg.content[0]?.text || "";

          // Stream response using real LLM
          res.writeHead(200, {
            "Content-Type": "text/plain",
            "Transfer-Encoding": "chunked",
          });

          const result = streamText({
            model: openai("gpt-4o-mini"),
            messages: [
              {
                role: "system",
                content:
                  "You are a helpful weather assistant. Provide brief, friendly responses, immediately. Pretend like you have access to a weather API and make up the weather.",
              },
              {
                role: "user",
                content,
              },
            ],
            temperature: 0.7,
          });

          // Stream chunks to client
          for await (const textPart of result.textStream) {
            res.write(textPart);
          }

          res.end();
        } catch (error) {
          console.error(error);
          res.writeHead(500);
          res.end("Error");
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

describe("Testing Remote Agents - Streaming Response", () => {
  it("should collect streaming chunks into complete response", async () => {
    const baseUrl = serverUrl;

    const streamingAdapter: AgentAdapter = {
      role: AgentRole.AGENT,
      call: async (input) => {
        // Request streaming response from your agent
        const response = await fetch(`${baseUrl}/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: input.messages }),
        });

        // Collect all chunks into a single response
        let fullResponse = "";
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break; // Stream complete

            // Decode chunk and append to full response
            fullResponse += decoder.decode(value, { stream: true });
          }
        }

        // Return complete response after all chunks received
        return fullResponse;
      },
    };

    const result = await scenario.run({
      name: "Streaming weather response",
      description: "User asks about weather and receives streamed response",
      agents: [
        scenario.userSimulatorAgent({ model: openai("gpt-4o-mini") }),
        streamingAdapter,
        scenario.judgeAgent({
          model: openai("gpt-4o-mini"),
          criteria: [
            "Agent should provide weather information",
            "Response should be complete and coherent",
          ],
        }),
      ],
      script: [
        scenario.user("What's the weather forecast in Amsterdam?"),
        scenario.agent(),
        scenario.judge(),
      ],
      setId: "javascript-examples",
    });

    expectResultsSuccess(result);
  });
});
