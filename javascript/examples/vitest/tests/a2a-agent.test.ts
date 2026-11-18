import { createServer, IncomingMessage, Server } from "http";
import { openai } from "@ai-sdk/openai";
import scenario from "@langwatch/scenario";
import { context, SpanKind, trace, TraceFlags } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { TracerProvider, BatchSpanProcessor, ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace";
import { generateText, ModelMessage } from "ai";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Example: test an A2A agent from nothing but its Agent Card URL.
 *
 * A small A2A agent runs locally (an Agent Card plus JSON-RPC `SendMessage`,
 * backed by a real model). `scenario.A2AAgent` reads the card and drives the
 * conversation; every request carries `traceparent`, so the server's spans
 * join the scenario trace of each turn. The server exports under its own OTel
 * resource (`service.name=acme-partner-agent`), like a partner's agent would.
 */

const MODEL = process.env.SCENARIO_EXAMPLE_MODEL ?? "gpt-5-mini";
const SYSTEM =
  "You are a support agent for ACME bikes. Refunds are allowed within 30 days of purchase. Be brief.";

const AGENT_NAME = "ACME Support Agent";
const SERVICE_NAME = "acme-partner-agent";

/** The A2A server's own OTel setup, separate from the scenario side. */
const partnerSpanProcessors = (): SpanProcessor[] => {
  const apiKey = process.env.LANGWATCH_API_KEY;
  if (!apiKey) return [];
  const endpoint = process.env.LANGWATCH_ENDPOINT ?? "https://app.langwatch.ai";
  const exporter = new OTLPTraceExporter({
    url: `${endpoint}/api/otel/v1/traces`,
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return [new BatchSpanProcessor({ exporter })];
};

const finishedSpans: ReadableSpan[] = [];
const partnerProvider = new TracerProvider({
  resource: resourceFromAttributes({ "service.name": SERVICE_NAME }),
  spanProcessors: [
    ...partnerSpanProcessors(),
    {
      onStart: () => undefined,
      onEnd: (span) => void finishedSpans.push(span),
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    },
  ],
});
const partnerTracer = partnerProvider.getTracer(SERVICE_NAME);

const histories = new Map<string, ModelMessage[]>();
const serverSpans: { traceparent: string; serverTraceId: string }[] = [];
let server: Server;
let baseUrl = "";

const readJson = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

/** Continues the caller's trace from the W3C `traceparent` header. */
const parentContext = (traceparent: string) => {
  const [, traceId, spanId, flags] = traceparent.split("-");
  if (!traceId || !spanId) return context.active();
  return trace.setSpanContext(context.active(), {
    traceId,
    spanId,
    traceFlags: parseInt(flags ?? "01", 16) as TraceFlags,
    isRemote: true,
  });
};

const agentCard = () => ({
  name: AGENT_NAME,
  description: "Answers questions about ACME bike orders and refunds",
  version: "1.0.0",
  supportedInterfaces: [
    { url: `${baseUrl}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  ],
  capabilities: { streaming: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{ id: "refunds", name: "Refunds", description: "Refund policy", tags: [] }],
});

/** JSON-RPC `SendMessage`: keeps one chat history per `contextId`. */
const sendMessage = async (req: IncomingMessage) => {
  const body = await readJson(req);
  const message = body.params.message;
  const contextId: string = message.contextId;
  const history = histories.get(contextId) ?? [];
  histories.set(contextId, history);
  history.push({ role: "user", content: message.parts[0].text });

  const traceparent = String(req.headers.traceparent ?? "");
  const text = await partnerTracer.startActiveSpan(
    `invoke_agent ${AGENT_NAME}`,
    {
      kind: SpanKind.SERVER,
      attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": AGENT_NAME },
    },
    parentContext(traceparent),
    async (agentSpan) => {
      try {
        const result = await partnerTracer.startActiveSpan(
          `chat ${MODEL}`,
          {
            kind: SpanKind.CLIENT,
            attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": MODEL },
          },
          async (llmSpan) => {
            try {
              const out = await generateText({
                model: openai.chat(MODEL),
                system: SYSTEM,
                messages: history,
              });
              llmSpan.setAttributes({
                "gen_ai.usage.input_tokens": out.usage.inputTokens ?? 0,
                "gen_ai.usage.output_tokens": out.usage.outputTokens ?? 0,
              });
              return out;
            } finally {
              llmSpan.end();
            }
          }
        );
        serverSpans.push({ traceparent, serverTraceId: agentSpan.spanContext().traceId });
        return result.text;
      } finally {
        agentSpan.end();
      }
    }
  );
  history.push({ role: "assistant", content: text });
  return {
    jsonrpc: "2.0",
    id: body.id,
    result: {
      message: {
        messageId: `m${history.length}`,
        contextId,
        role: "ROLE_AGENT",
        parts: [{ text }],
      },
    },
  };
};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(agentCard()));
      } else if (req.method === "POST" && req.url === "/a2a") {
        const reply = await sendMessage(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (error) {
      console.error(error);
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" ? address?.port : 3000;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await partnerProvider.forceFlush();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Testing an A2A agent", () => {
  it("drives the agent from its Agent Card and propagates the trace", async () => {
    serverSpans.length = 0;
    finishedSpans.length = 0;
    histories.clear();
    const result = await scenario.run({
      name: "A2A refund request",
      description: "A customer bought a bike two weeks ago and asks for a refund",
      agents: [
        new scenario.A2AAgent({ cardUrl: `${baseUrl}/.well-known/agent-card.json` }),
        scenario.userSimulatorAgent({ model: openai.chat(MODEL) }),
        scenario.judgeAgent({
          model: openai.chat(MODEL),
          criteria: ["The agent says the refund is possible"],
        }),
      ],
      script: [
        scenario.user("Hi, I bought a bike from you two weeks ago. Can I get a refund?"),
        scenario.agent(),
        scenario.user(),
        scenario.agent(),
        scenario.judge(),
      ],
      setId: "javascript-examples",
    });

    for (const turn of serverSpans) {
      console.log(`A2A server span: traceparent=${turn.traceparent} server_trace_id=${turn.serverTraceId}`);
    }
    expect(serverSpans).toHaveLength(2);
    expect([...histories.values()].map((h) => h.length)).toEqual([4]);
    for (const turn of serverSpans) {
      expect(turn.traceparent.split("-")[1]).toBe(turn.serverTraceId);
    }
    const agentSpans = finishedSpans.filter(
      (s) => s.attributes["gen_ai.operation.name"] === "invoke_agent"
    );
    expect(agentSpans.map((s) => s.attributes["gen_ai.agent.name"])).toEqual([AGENT_NAME, AGENT_NAME]);
    for (const agentSpan of agentSpans) {
      expect(agentSpan.resource.attributes["service.name"]).toBe(SERVICE_NAME);
      const llmSpan = finishedSpans.find(
        (s) => s.parentSpanContext?.spanId === agentSpan.spanContext().spanId
      );
      expect(llmSpan?.attributes["gen_ai.operation.name"]).toBe("chat");
    }
    expect(result.success, result.reasoning).toBe(true);
  });
});
