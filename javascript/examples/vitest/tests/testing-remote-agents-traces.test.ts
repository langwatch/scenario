import { createServer, Server } from "http";
import { openai } from "@ai-sdk/openai";
import scenario, { AgentRole, type AgentAdapter } from "@langwatch/scenario";
import { context, propagation } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { generateText, ModelMessage, stepCountIs, tool } from "ai";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod/v4";

/**
 * Example: Judging a remote HTTP agent on its real traces
 *
 * The agent under test runs behind an HTTP endpoint and returns final text
 * only — the judge cannot see its tool calls in the response. Two pieces fix
 * that:
 *
 * 1. The adapter spreads `input.propagationHeaders` onto the outgoing request,
 *    and the server adopts the incoming trace context. The agent's spans land
 *    in the same trace as the scenario turn.
 * 2. `fetchRemoteTraces: true` makes the judge fetch those traces from
 *    LangWatch and evaluate criteria about internal behavior (tool calls,
 *    lookups) against real spans instead of claims in the transcript.
 */

// The server side needs a registered propagator to extract the incoming
// `traceparent`. Standard OTel HTTP instrumentation does this on its own; this
// demo server is hand-rolled, so register the W3C propagator explicitly.
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

let server: Server;
let serverUrl: string;

/** Simulated order system lookup — the internal behavior the judge verifies. */
const lookupOrderStatus = tool({
  description: "Look up the current status of an order by its id",
  inputSchema: z.object({
    orderId: z.string().describe("The order id to look up"),
  }),
  execute: async ({ orderId }) => {
    return { orderId, status: "shipped", carrier: "DHL" };
  },
});

beforeAll(async () => {
  // The "remote" agent: an HTTP endpoint that adopts the incoming trace
  // context and answers with final text only.
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/chat") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const { messages } = JSON.parse(body) as { messages: ModelMessage[] };

          // Adopt the propagated trace context: every span created inside
          // this callback joins the scenario turn's trace.
          const extracted = propagation.extract(context.active(), req.headers);
          const result = await context.with(extracted, () =>
            generateText({
              model: openai("gpt-5-mini"),
              messages: [
                {
                  role: "system",
                  content:
                    "You are an order support assistant. Use the lookup_order_status tool to check orders before answering.",
                },
                ...messages,
              ],
              tools: { lookup_order_status: lookupOrderStatus },
              stopWhen: stepCountIs(3),
              experimental_telemetry: { isEnabled: true },
            })
          );

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

describe("Testing Remote Agents - Judging on Remote Traces", () => {
  it("verifies the tool call through the propagated trace, not the transcript", async () => {
    const baseUrl = serverUrl;

    const remoteAgentAdapter: AgentAdapter = {
      role: AgentRole.AGENT,
      call: async (input) => {
        const response = await fetch(`${baseUrl}/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Forward the turn's trace context so the remote agent's spans
            // join the scenario trace.
            ...input.propagationHeaders,
          },
          body: JSON.stringify({ messages: input.messages }),
        });
        if (!response.ok) {
          throw new Error(`Remote agent returned HTTP ${response.status}`);
        }
        return ((await response.json()) as { response: string }).response;
      },
    };

    const result = await scenario.run({
      name: "Remote agent trace judging",
      description:
        "A customer asks where order ORD-1042 is. The agent must check the order system before answering.",
      agents: [
        scenario.userSimulatorAgent({ model: openai("gpt-5-mini") }),
        remoteAgentAdapter,
        scenario.judgeAgent({ model: openai("gpt-5-mini") }),
      ],
      script: [
        scenario.user("Where is my order ORD-1042?"),
        scenario.agent(),
        scenario.judge({
          criteria: [
            "The agent tells the user the current status of their order",
            "The agent looked the order up in the order system (a lookup_order_status tool span exists)",
          ],
        }),
      ],
      maxTurns: 5,
      // Judge on the real traces of the remote agent.
      fetchRemoteTraces: true,
      traceWaitTimeoutMs: 30_000,
      setId: "javascript-examples",
    });

    console.log(result);
    expect(result.success).toBe(true);
  });
});
