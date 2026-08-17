/**
 * Remote trace fetching, end to end through the executor.
 *
 * Binds the @integration scenario of `specs/remote-trace-fetching.feature`:
 * a real ScenarioExecution run (the same path `scenario.run()` takes) against
 * a fake LangWatch trace API served over real HTTP — the only mocked boundary.
 * The judge is the real JudgeAgent with `invokeLLM` overridden to capture the
 * LLM request and return a canned finish_test verdict.
 */

import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { SimpleSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { expect } from "vitest";

// Register a context manager ONCE so context.with propagates across awaits.
const ctxManager = new AsyncLocalStorageContextManager();
ctxManager.enable();
context.setGlobalContextManager(ctxManager);

import {
  AgentAdapter,
  AgentInput,
  AgentReturnTypes,
  AgentRole,
  ScenarioResult,
  UserSimulatorAgentAdapter,
} from "../../../domain";
import { ScenarioExecution } from "../../../execution";
import { user, agent as agentStep, judge as judgeStep } from "../../../script";
import { RemoteTraceFetcher } from "../../../tracing/remote-trace-fetcher";
import { InvokeLLMParams } from "../../types";
import { judgeAgent } from "../judge-agent";
import { JudgeSpanCollector } from "../judge-span-collector";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  "specs",
  "remote-trace-fetching.feature"
);

class StubAgent extends AgentAdapter {
  role = AgentRole.AGENT;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return "Done, I wrote your order to the database.";
  }
}

class StubUserSim extends UserSimulatorAgentAdapter {
  async call(): Promise<AgentReturnTypes> {
    return "hi";
  }
}

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Background, Scenario }) => {
    Background(({ Given, And }) => {
      Given("a scenario with fetch_remote_traces enabled", () => {
        // The execution below runs with fetchRemoteTraces: true.
      });
      And(
        "an agent adapter that forwards the propagation headers to a remote HTTP agent",
        () => {
          // The remote agent's spans exist only behind the fake trace API.
        }
      );
    });

    Scenario(
      "Remote spans reach the judge prompt through the standard digest",
      ({ Given, When, Then }) => {
        let server: Server;
        let serverUrl: string;
        let provider: NodeTracerProvider;
        let collector: JudgeSpanCollector;
        let capturedParams: InvokeLLMParams | undefined;
        let result: ScenarioResult;

        Given(
          "a fake LangWatch trace API returning a trace with a tool span",
          async () => {
            server = createServer((req, res) => {
              const match = /^\/api\/trace\/([0-9a-f]+)$/.exec(req.url ?? "");
              if (req.method === "GET" && match) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    trace_id: match[1],
                    spans: [
                      {
                        span_id: "feedfeedfeedfeed",
                        trace_id: match[1],
                        type: "tool",
                        name: "db.write_orders",
                        input: { type: "json", value: { table: "orders" } },
                        output: { type: "text", value: "1 row written" },
                        timestamps: {
                          started_at: Date.now() - 200,
                          finished_at: Date.now(),
                        },
                      },
                    ],
                  })
                );
                return;
              }
              res.writeHead(404);
              res.end();
            });
            await new Promise<void>((resolveListen) => {
              server.listen(0, () => {
                const address = server.address();
                const port =
                  typeof address === "object" && address ? address.port : 0;
                serverUrl = `http://127.0.0.1:${port}`;
                resolveListen();
              });
            });

            collector = new JudgeSpanCollector();
            provider = new NodeTracerProvider({
              // Multiple @opentelemetry/sdk-trace-base copies coexist in the
              // tree; cast to the type the provider expects.
              spanProcessors: [
                collector,
                new SimpleSpanProcessor(new InMemorySpanExporter()),
              ] as unknown as NonNullable<
                ConstructorParameters<typeof NodeTracerProvider>[0]
              >["spanProcessors"],
            });
            trace.setGlobalTracerProvider(provider);
          }
        );

        When(
          "the scenario runs to a verdict with fetch_remote_traces enabled",
          async () => {
            const judge = judgeAgent({
              model: "openai/gpt-5-mini",
              criteria: ["The agent writes the order to the database"],
              spanCollector: collector,
              traceFetcher: new RemoteTraceFetcher({ pollIntervalMs: 25 }),
            });
            judge.invokeLLM = async (params) => {
              capturedParams = params;
              return {
                text: "",
                content: [],
                toolCalls: [
                  {
                    type: "tool-call",
                    toolCallId: "tc-1",
                    toolName: "finish_test",
                    input: {
                      criteria: {
                        the_agent_writes_the_order_to_the_database: "true",
                      },
                      reasoning: "The db.write_orders span proves the write",
                      verdict: "success",
                    },
                  },
                ],
                toolResults: [],
              } as never;
            };

            const execution = new ScenarioExecution(
              {
                name: "remote trace integration",
                description:
                  "A user asks the agent to write an order to the database",
                agents: [new StubAgent(), new StubUserSim(), judge],
                fetchRemoteTraces: true,
                traceWaitTimeoutMs: 10_000,
                langwatch: { endpoint: serverUrl, apiKey: "test-key" },
              },
              [
                user("Please write my order to the database"),
                agentStep(),
                judgeStep(),
              ],
              "batch-integration"
            );
            result = await execution.execute();
          }
        );

        Then(
          "the judge LLM request contains the tool span inside the opentelemetry_traces section",
          async () => {
            expect(capturedParams).toBeDefined();
            const userMessage = capturedParams?.messages?.find(
              (m) => "role" in m && m.role === "user"
            );
            const content =
              typeof userMessage?.content === "string"
                ? userMessage.content
                : JSON.stringify(userMessage?.content);
            const tracesSection = content.slice(
              content.indexOf("<opentelemetry_traces>"),
              content.indexOf("</opentelemetry_traces>")
            );
            expect(tracesSection).toContain("db.write_orders");
            expect(tracesSection).toContain("1 row written");
            expect(result.success).toBe(true);

            await provider.shutdown();
            trace.disable();
            await new Promise<void>((resolveClose) => {
              server.close(() => resolveClose());
            });
          }
        );
      }
    );
  },
  { includeTags: [["integration"]] }
);
