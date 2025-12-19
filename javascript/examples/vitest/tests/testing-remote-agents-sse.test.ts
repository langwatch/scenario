import { createServer, Server } from "http";
import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { streamText } from "ai";
import { describe, it, beforeAll, afterAll } from "vitest";
import { expectResultsSuccess } from "./helpers/expect-results-success";

/**
 * Example: Testing an agent that returns Server-Sent Events (SSE)
 *
 * This demonstrates the SSE format commonly used by OpenAI and similar APIs.
 * Each chunk is sent as "data: {json}\n\n" and the stream ends with "data: [DONE]\n\n".
 */

let server: Server;
let serverUrl: string;

beforeAll(async () => {
  // Create server that streams SSE format
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/chat/sse") {
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

          // Set up SSE response headers
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          // Stream response using real LLM
          const result = streamText({
            model: openai("gpt-4o-mini"),
            messages: [
              {
                role: "system",
                content:
                  "You are a helpful weather assistant. Provide brief, friendly responses. Pretend you have access to weather data. Pretend like you have access to a weather API and make up the weather.",
              },
              {
                role: "user",
                content,
              },
            ],
            temperature: 0.7,
          });

          // Stream chunks in SSE format
          for await (const textPart of result.textStream) {
            // SSE format: "data: {json}\n\n"
            res.write(`data: ${JSON.stringify({ content: textPart })}\n\n`);
          }

          // Send completion marker
          res.write("data: [DONE]\n\n");
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

describe("Testing Remote Agents - Server-Sent Events", () => {
  it("should parse SSE format and collect complete response", async () => {
    const baseUrl = serverUrl;

    const sseAdapter: AgentAdapter = {
      role: AgentRole.AGENT,
      call: async (input) => {
        // Request SSE stream from your agent
        const response = await fetch(`${baseUrl}/chat/sse`, {
          method: "POST",
          headers: {
            Accept: "text/event-stream", // Indicate we expect SSE format
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ messages: input.messages }),
        });

        let fullResponse = "";
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        if (reader) {
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break; // Stream complete

            // Decode chunk and add to buffer
            buffer += decoder.decode(value, { stream: true });

            // Process complete lines
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // Keep incomplete line in buffer

            // Parse SSE format: "data: {...}\n"
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6); // Remove "data: " prefix

                // Check for SSE stream end marker
                if (data !== "[DONE]") {
                  try {
                    // Parse JSON and extract content field
                    const parsed = JSON.parse(data);
                    fullResponse += parsed.content;
                  } catch {
                    // Skip malformed JSON
                  }
                }
              }
            }
          }
        }

        // Return complete response after stream ends
        return fullResponse;
      },
    };

    const result = await scenario.run({
      name: "SSE weather response",
      description: "User asks about weather and receives SSE-formatted stream",
      agents: [
        scenario.userSimulatorAgent({ model: openai("gpt-4o-mini") }),
        sseAdapter,
        scenario.judgeAgent({
          model: openai("gpt-4o-mini"),
          criteria: [
            "Agent should provide weather information",
            "Response should be complete and coherent",
          ],
        }),
      ],
      script: [
        scenario.user("What's the weather like in Tokyo today?"),
        scenario.agent(),
        scenario.judge(),
      ],
      setId: "javascript-examples",
    });

    expectResultsSuccess(result);
  });
});
