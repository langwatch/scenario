/**
 * Remote trace fetching for judge evaluation.
 *
 * Binds the @unit scenarios of `specs/remote-trace-fetching.feature`:
 * propagation headers on AgentInput, the per-turn trace id fan-out, the
 * no-fetch conversation turns, the verdict-time settle-wait, the
 * make_verdict-then-settle flow, failure semantics, dedupe/filtering, and
 * the off-by-default contract.
 *
 * Mechanics mirror `judge-agent.test.ts`: a real JudgeSpanCollector fed via
 * onEnd, `agent.invokeLLM` overridden to capture params and return canned
 * tool calls, and a RemoteTraceFetcher with an injected fake fetch.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ModelMessage } from "ai";
import { describe, it, expect, vi } from "vitest";

// Register a context manager ONCE so the agent-call span is active when
// AgentInput builds its propagation headers via context.active().
const ctxManager = new AsyncLocalStorageContextManager();
ctxManager.enable();
context.setGlobalContextManager(ctxManager);

import { getProjectConfig } from "../../../config";
import {
  AgentAdapter,
  AgentInput,
  AgentReturnTypes,
  AgentRole,
  ScenarioResult,
  UserSimulatorAgentAdapter,
} from "../../../domain";
import { scenarioProjectConfigSchema } from "../../../domain/core/config";
import { ScenarioExecution } from "../../../execution";
import { user, agent as agentStep, succeed } from "../../../script";
import type { LangWatchApiSpan } from "../../../tracing/langwatch-api-span";
import { RemoteTraceFetcher } from "../../../tracing/remote-trace-fetcher";
import { InvokeLLMParams, InvokeLLMResult } from "../../types";
import type { JudgeResult } from "../interfaces/judge-result.interface";
import { judgeAgent, JudgeAgentConfig } from "../judge-agent";
import { JudgeSpanCollector } from "../judge-span-collector";
import { createSpan } from "./helpers/create-span";

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

vi.mock("../../../config", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../config")>();
  return {
    ...original,
    getProjectConfig: vi.fn().mockResolvedValue({
      defaultModel: { model: "openai/gpt-5-mini", temperature: 0 },
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THREAD_ID = "remote-thread";
const LANGWATCH = { endpoint: "https://langwatch.test", apiKey: "key-123" };
const TRACE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const TRACE_B = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2";
const TRACE_C = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3";

const REMOTE_TRACE_RULE =
  "Criteria about the agent's internal behavior (tool calls, database writes, API calls, retrievals) must be verified against the <opentelemetry_traces> section, not against claims in the transcript. If a span named langwatch.span_collection.error is present, read its reason: when no agent spans arrived, mark criteria that depend on internal behavior as inconclusive, never passed. When the trace is incomplete, criteria proven by the spans that are present may pass, and criteria whose evidence is missing stay inconclusive. Criteria about the conversation itself are unaffected by missing traces: judge them from the transcript as normal. Never mark internal-behavior criteria as passed based on the transcript alone.";

function toolSpan(traceId: string, spanId: string): LangWatchApiSpan {
  return {
    span_id: spanId,
    trace_id: traceId,
    type: "tool",
    name: "db.write_orders",
    input: { type: "json", value: { table: "orders" } },
    timestamps: {
      started_at: 1_700_000_000_000,
      finished_at: 1_700_000_000_200,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * Fake trace API keyed per trace id: each request for a trace id shifts the
 * next scripted result for that id; the last result repeats. Records every
 * requested trace id in order.
 */
function fakeTraceApi(
  script: Record<string, Array<LangWatchApiSpan[] | "404">>
) {
  const requestedTraceIds: string[] = [];
  const queues = new Map(
    Object.entries(script).map(([traceId, results]) => [traceId, [...results]])
  );
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    const traceId = url.slice(url.lastIndexOf("/") + 1);
    requestedTraceIds.push(traceId);
    const queue = queues.get(traceId) ?? ["404" as const];
    const result = queue.length > 1 ? queue.shift() : queue[0];
    if (result === "404" || result === undefined) {
      return jsonResponse({ error: "not found" }, 404);
    }
    return jsonResponse({ trace_id: traceId, spans: result });
  };
  return { requestedTraceIds, fetchFn };
}

function tracedMessage(
  role: "user" | "assistant",
  content: string,
  traceId?: string
): ModelMessage {
  const message: ModelMessage & { traceId?: string } = { role, content };
  if (traceId) message.traceId = traceId;
  return message;
}

function judgeInput({
  messages,
  currentTurn = 1,
  maxTurns = 5,
  judgmentRequest,
  scenarioConfigExtra,
}: {
  messages: ModelMessage[];
  currentTurn?: number;
  maxTurns?: number;
  judgmentRequest?: AgentInput["judgmentRequest"];
  scenarioConfigExtra?: Record<string, unknown>;
}): AgentInput {
  return {
    threadId: THREAD_ID,
    messages,
    newMessages: [],
    requestedRole: AgentRole.JUDGE,
    judgmentRequest,
    propagationHeaders: {},
    scenarioState: { currentTurn } as unknown as AgentInput["scenarioState"],
    scenarioConfig: {
      name: "remote traces test",
      description: "A scenario against a remote HTTP agent",
      maxTurns,
      fetchRemoteTraces: true,
      traceWaitTimeoutMs: 5_000,
      langwatch: LANGWATCH,
      ...scenarioConfigExtra,
    } as unknown as AgentInput["scenarioConfig"],
  };
}

function mockLLMResult(toolName: string, input: unknown): InvokeLLMResult {
  return {
    text: "",
    content: [],
    toolCalls: [
      {
        toolName,
        input,
        type: "tool-call" as const,
        toolCallId: "tc-1",
      },
    ],
    toolResults: [],
  } as unknown as InvokeLLMResult;
}

function finishTest(
  verdict: "success" | "failure",
  reasoning = "done"
): InvokeLLMResult {
  return mockLLMResult("finish_test", {
    criteria: {
      the_agent_writes_the_order_to_the_database:
        verdict === "success" ? "true" : "false",
    },
    reasoning,
    verdict,
  });
}

function makeJudge({
  collector,
  fetcher,
  criteria = ["The agent writes the order to the database"],
}: {
  collector: JudgeSpanCollector;
  fetcher: RemoteTraceFetcher;
  criteria?: string[];
}) {
  const config: JudgeAgentConfig = {
    criteria,
    spanCollector: collector,
    traceFetcher: fetcher,
  };
  return judgeAgent(config);
}

function userMessageContent(params: InvokeLLMParams | undefined): string {
  const userMessage = params?.messages?.find(
    (m) => "role" in m && m.role === "user"
  );
  if (!userMessage) throw new Error("Expected a user message in LLM call");
  return typeof userMessage.content === "string"
    ? userMessage.content
    : JSON.stringify(userMessage.content);
}

function systemMessageContent(params: InvokeLLMParams | undefined): string {
  const systemMessage = params?.messages?.find(
    (m) => "role" in m && m.role === "system"
  );
  if (!systemMessage) throw new Error("Expected a system message in LLM call");
  return typeof systemMessage.content === "string"
    ? systemMessage.content
    : JSON.stringify(systemMessage.content);
}

// ---------------------------------------------------------------------------
// Bound feature-file scenarios
// ---------------------------------------------------------------------------

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Background, Scenario, AfterEachScenario }) => {
    let provider: NodeTracerProvider | undefined;

    AfterEachScenario(async () => {
      if (provider) {
        await provider.shutdown();
        provider = undefined;
        trace.disable();
        propagation.disable();
      }
    });

    Background(({ Given, And }) => {
      Given("a scenario with fetch_remote_traces enabled", () => {
        // Each scenario builds its own AgentInput with fetchRemoteTraces: true
        // (except the off-by-default scenario, which omits it on purpose).
      });
      And(
        "an agent adapter that forwards the propagation headers to a remote HTTP agent",
        () => {
          // The remote agent is represented by the fake trace API: its spans
          // exist only behind GET /api/trace/{traceId}.
        }
      );
    });

    // -----------------------------------------------------------------------
    Scenario(
      "AgentInput carries W3C propagation headers for the current turn",
      ({ Given, When, Then, And }) => {
        let captured: AgentInput | undefined;
        let result: ScenarioResult;

        Given("a scenario turn is in progress", () => {
          const exporter = new InMemorySpanExporter();
          provider = new NodeTracerProvider({
            // Multiple @opentelemetry/sdk-trace-base copies coexist in the
            // tree; cast to the type the provider expects.
            spanProcessors: [
              new SimpleSpanProcessor(exporter),
            ] as unknown as NonNullable<
              ConstructorParameters<typeof NodeTracerProvider>[0]
            >["spanProcessors"],
          });
          trace.setGlobalTracerProvider(provider);
          propagation.setGlobalPropagator(new W3CTraceContextPropagator());
        });

        When("the agent adapter receives its AgentInput", async () => {
          class CapturingAgent extends AgentAdapter {
            role = AgentRole.AGENT;
            async call(input: AgentInput): Promise<AgentReturnTypes> {
              captured = input;
              return "Order written.";
            }
          }
          class StubUserSim extends UserSimulatorAgentAdapter {
            async call(): Promise<AgentReturnTypes> {
              return "hi";
            }
          }
          const execution = new ScenarioExecution(
            {
              name: "propagation headers",
              description: "captures the AgentInput of a turn",
              agents: [new CapturingAgent(), new StubUserSim()],
            },
            [user("Write my order"), agentStep(), succeed("captured")],
            "batch-1"
          );
          result = await execution.execute();
        });

        Then(
          "the input exposes propagation headers containing a traceparent",
          () => {
            expect(captured).toBeDefined();
            expect(captured?.propagationHeaders?.traceparent).toMatch(
              /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/
            );
          }
        );

        And(
          "the traceparent trace id equals the trace id stamped on the turn's messages",
          () => {
            const traceparent = captured?.propagationHeaders?.traceparent ?? "";
            const traceparentTraceId = traceparent.split("-")[1];
            const assistantMessage = result.messages.find(
              (m) => m.role === "assistant"
            ) as (ModelMessage & { traceId?: string }) | undefined;
            expect(assistantMessage?.traceId).toBe(traceparentTraceId);
          }
        );
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "The judge fetches traces for every turn, not only the last",
      ({ Given, When, Then }) => {
        let api: ReturnType<typeof fakeTraceApi>;
        let input: AgentInput;
        let judge: ReturnType<typeof judgeAgent>;

        Given(
          "a finished conversation with three turns and three distinct message trace ids",
          () => {
            api = fakeTraceApi({
              [TRACE_A]: [[toolSpan(TRACE_A, "b000000000000001")]],
              [TRACE_B]: [[toolSpan(TRACE_B, "b000000000000002")]],
              [TRACE_C]: [[toolSpan(TRACE_C, "b000000000000003")]],
            });
            const collector = new JudgeSpanCollector();
            const fetcher = new RemoteTraceFetcher({
              fetchFn: api.fetchFn,
              pollIntervalMs: 1,
            });
            judge = makeJudge({ collector, fetcher });
            judge.invokeLLM = async () => finishTest("success");
            input = judgeInput({
              messages: [
                tracedMessage("user", "turn 1", TRACE_A),
                tracedMessage("assistant", "ok 1", TRACE_A),
                tracedMessage("user", "turn 2", TRACE_B),
                tracedMessage("assistant", "ok 2", TRACE_B),
                tracedMessage("user", "turn 3", TRACE_C),
                tracedMessage("assistant", "ok 3", TRACE_C),
              ],
              currentTurn: 4,
            });
          }
        );

        When("the judge issues its verdict", async () => {
          await judge.call(input);
        });

        Then("the remote fetcher is asked for all three trace ids", () => {
          const distinct = new Set(api.requestedTraceIds);
          expect(distinct).toEqual(new Set([TRACE_A, TRACE_B, TRACE_C]));
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "Conversation turns never fetch remote traces",
      ({ Given, When, Then }) => {
        let api: ReturnType<typeof fakeTraceApi>;
        let judge: ReturnType<typeof judgeAgent>;
        let result: Awaited<ReturnType<typeof judge.call>>;

        Given(
          "the judge is called mid-conversation and decides to continue",
          () => {
            api = fakeTraceApi({ [TRACE_A]: ["404"] });
            const collector = new JudgeSpanCollector();
            const fetcher = new RemoteTraceFetcher({
              fetchFn: api.fetchFn,
              pollIntervalMs: 1,
            });
            judge = makeJudge({ collector, fetcher });
            judge.invokeLLM = async () => mockLLMResult("continue_test", {});
          }
        );

        When("the decision call completes", async () => {
          result = await judge.call(
            judgeInput({
              messages: [
                tracedMessage("user", "turn 1"),
                tracedMessage("assistant", "ok", TRACE_A),
              ],
              currentTurn: 1,
            })
          );
        });

        Then("no remote trace fetch happens at all", () => {
          expect(api.requestedTraceIds).toHaveLength(0);
          expect(result).toBeNull();
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "A forced verdict settle-waits until the remote trace is complete",
      ({ Given, And, When, Then }) => {
        let api: ReturnType<typeof fakeTraceApi>;
        let judge: ReturnType<typeof judgeAgent>;
        let input: AgentInput;
        let capturedParams: InvokeLLMParams | undefined;

        Given("the conversation reached its final turn", () => {
          input = judgeInput({
            messages: [
              tracedMessage("user", "write the order"),
              tracedMessage("assistant", "I wrote it", TRACE_A),
            ],
            currentTurn: 4,
          });
        });

        And(
          "a remote trace becomes available only after two poll rounds",
          () => {
            api = fakeTraceApi({
              [TRACE_A]: [
                "404",
                "404",
                [toolSpan(TRACE_A, "b000000000000001")],
              ],
            });
            const collector = new JudgeSpanCollector();
            const fetcher = new RemoteTraceFetcher({
              fetchFn: api.fetchFn,
              pollIntervalMs: 1,
            });
            judge = makeJudge({ collector, fetcher });
            judge.invokeLLM = async (params) => {
              capturedParams = params;
              return finishTest("success");
            };
          }
        );

        When("the judge issues its verdict", async () => {
          await judge.call(input);
        });

        Then(
          "the fetcher polls until every fetched agent span's parent resolves within the fetched and locally collected spans",
          () => {
            // 404, 404, then the parentless root span arrives: the trace is
            // parent-resolved with a remote span, so it settles on that poll.
            expect(api.requestedTraceIds).toEqual([TRACE_A, TRACE_A, TRACE_A]);
          }
        );

        And("the fetched spans are present in the judge's trace digest", () => {
          const content = userMessageContent(capturedParams);
          expect(content).toContain("<opentelemetry_traces>");
          expect(content).toContain("db.write_orders");
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "Chunked ingestion does not settle on a partial trace",
      ({ Given, And, When, Then }) => {
        let api: ReturnType<typeof fakeTraceApi>;
        let collector: JudgeSpanCollector;
        let fetcher: RemoteTraceFetcher;

        const partialChunk = [
          {
            ...toolSpan(TRACE_A, "c000000000000002"),
            name: "tools.round_one",
            parent_id: "c000000000000001",
          },
        ];
        const fullTrace = [
          { ...toolSpan(TRACE_A, "c000000000000001"), name: "agent.request" },
          ...partialChunk,
          {
            ...toolSpan(TRACE_A, "c000000000000003"),
            parent_id: "c000000000000001",
          },
        ];

        Given(
          "remote spans arrive in chunks spaced more than one poll apart",
          () => {
            // The partial chunk repeats across three polls: a count-stability
            // rule would have settled on it and missed the later spans.
            api = fakeTraceApi({
              [TRACE_A]: [partialChunk, partialChunk, partialChunk, fullTrace],
            });
            collector = new JudgeSpanCollector();
            fetcher = new RemoteTraceFetcher({
              fetchFn: api.fetchFn,
              pollIntervalMs: 1,
            });
          }
        );

        And("the chunk that contains the trace root span arrives last", () => {
          // fullTrace, queued last, is the only response containing the
          // parentless agent.request root span.
        });

        When("the judge issues its verdict", async () => {
          await fetcher.settleWait({
            threadId: THREAD_ID,
            traceIds: [TRACE_A],
            collector,
            langwatch: LANGWATCH,
            timeoutMs: 5_000,
          });
        });

        Then("the fetcher keeps polling past the partial chunks", () => {
          expect(api.requestedTraceIds).toEqual([
            TRACE_A,
            TRACE_A,
            TRACE_A,
            TRACE_A,
          ]);
        });

        And("the verdict sees the spans from the last chunk", () => {
          const names = collector
            .getSpansForThread(THREAD_ID)
            .map((span) => span.name);
          expect(names).toContain("agent.request");
          expect(names).toContain("db.write_orders");
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "An incomplete trace at the deadline keeps its spans and gains an error span",
      ({ Given, When, Then, And }) => {
        let api: ReturnType<typeof fakeTraceApi>;
        let collector: JudgeSpanCollector;
        let fetcher: RemoteTraceFetcher;

        Given(
          "a remote trace whose spans reference a parent span that never arrives",
          () => {
            api = fakeTraceApi({
              [TRACE_A]: [
                [
                  {
                    ...toolSpan(TRACE_A, "c000000000000010"),
                    parent_id: "c0000000000000ff",
                  },
                ],
              ],
            });
            collector = new JudgeSpanCollector();
            fetcher = new RemoteTraceFetcher({
              fetchFn: api.fetchFn,
              pollIntervalMs: 1,
            });
          }
        );

        When(
          "the judge issues its verdict and the wait deadline expires",
          async () => {
            await fetcher.settleWait({
              threadId: THREAD_ID,
              traceIds: [TRACE_A],
              collector,
              langwatch: LANGWATCH,
              timeoutMs: 40,
            });
          }
        );

        Then("the collected spans remain available to the judge", () => {
          expect(api.requestedTraceIds.length).toBeGreaterThan(2);
          const names = collector
            .getSpansForThread(THREAD_ID)
            .map((span) => span.name);
          expect(names).toContain("db.write_orders");
        });

        And(
          "the trace digest contains a span named langwatch.span_collection.error marking the trace incomplete",
          () => {
            const errorSpan = collector
              .getSpansForThread(THREAD_ID)
              .find((span) => span.name === "langwatch.span_collection.error");
            expect(errorSpan).toBeDefined();
            expect(
              errorSpan?.attributes["langwatch.span_collection.error.reason"]
            ).toContain("still incomplete");
          }
        );
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "A trace containing only the scenario's own spans does not settle",
      ({ Given, When, Then, And }) => {
        let api: ReturnType<typeof fakeTraceApi>;
        let collector: JudgeSpanCollector;
        let fetcher: RemoteTraceFetcher;

        Given(
          "the fetched trace contains only spans already collected locally",
          () => {
            collector = new JudgeSpanCollector();
            collector.onEnd(
              createSpan({
                spanId: "b000000000000001",
                name: "local.op",
                startTime: [1_700_000_000, 0],
                endTime: [1_700_000_001, 0],
                attributes: { "langwatch.thread.id": THREAD_ID },
              })
            );
            api = fakeTraceApi({
              [TRACE_A]: [
                [{ ...toolSpan(TRACE_A, "b000000000000001"), name: "local.op" }],
              ],
            });
            fetcher = new RemoteTraceFetcher({
              fetchFn: api.fetchFn,
              pollIntervalMs: 1,
            });
          }
        );

        When("the judge issues its verdict", async () => {
          await fetcher.settleWait({
            threadId: THREAD_ID,
            traceIds: [TRACE_A],
            collector,
            langwatch: LANGWATCH,
            timeoutMs: 60,
          });
        });

        Then("the fetcher keeps polling until the timeout", () => {
          expect(api.requestedTraceIds.length).toBeGreaterThan(3);
        });

        And(
          "the trace digest contains a span named langwatch.span_collection.error",
          () => {
            const names = collector
              .getSpansForThread(THREAD_ID)
              .map((span) => span.name);
            expect(names).toContain("langwatch.span_collection.error");
          }
        );
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "The scenario's own spans echoed back do not block settling",
      ({ Given, And, When, Then }) => {
        let api: ReturnType<typeof fakeTraceApi>;
        let collector: JudgeSpanCollector;
        let fetcher: RemoteTraceFetcher;

        Given(
          "the platform echoes back one of the scenario's own spans whose parent span is still open",
          () => {
            collector = new JudgeSpanCollector();
            // The adapter span ended and was collected; its parent (the turn
            // span) is still open, so it is neither fetched nor collected.
            collector.onEnd(
              createSpan({
                spanId: "b000000000000002",
                name: "adapter.call",
                startTime: [1_700_000_000, 0],
                endTime: [1_700_000_001, 0],
                attributes: { "langwatch.thread.id": THREAD_ID },
              })
            );
          }
        );

        And("the agent's spans are fully ingested", () => {
          api = fakeTraceApi({
            [TRACE_A]: [
              [
                {
                  ...toolSpan(TRACE_A, "b000000000000002"),
                  name: "adapter.call",
                  parent_id: "b000000000000001",
                },
                {
                  ...toolSpan(TRACE_A, "c000000000000001"),
                  name: "agent.request",
                  parent_id: "b000000000000002",
                },
              ],
            ],
          });
          fetcher = new RemoteTraceFetcher({
            fetchFn: api.fetchFn,
            pollIntervalMs: 1,
          });
        });

        When("the judge issues its verdict", async () => {
          await fetcher.settleWait({
            threadId: THREAD_ID,
            traceIds: [TRACE_A],
            collector,
            langwatch: LANGWATCH,
            timeoutMs: 5_000,
          });
        });

        Then("the trace settles on the first poll", () => {
          expect(api.requestedTraceIds).toEqual([TRACE_A]);
          const names = collector
            .getSpansForThread(THREAD_ID)
            .map((span) => span.name);
          expect(names).toContain("agent.request");
          expect(names).not.toContain("langwatch.span_collection.error");
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "A make_verdict decision settles the traces before the verdict",
      ({ Given, When, Then, And }) => {
        let judge: ReturnType<typeof judgeAgent>;
        let result: Awaited<ReturnType<typeof judge.call>>;
        const invocations: InvokeLLMParams[] = [];

        Given(
          "the judge decides mid-conversation that enough information has been collected",
          () => {
            const api = fakeTraceApi({
              [TRACE_A]: [
                "404",
                [toolSpan(TRACE_A, "b000000000000001")],
              ],
            });
            const collector = new JudgeSpanCollector();
            const fetcher = new RemoteTraceFetcher({
              fetchFn: api.fetchFn,
              pollIntervalMs: 1,
            });
            judge = makeJudge({ collector, fetcher });
            judge.invokeLLM = async (params) => {
              invocations.push(params);
              // First call: the decision. Second call: the verdict, made
              // with the settled trace in the digest.
              return invocations.length === 1
                ? mockLLMResult("make_verdict", {})
                : finishTest("failure", "the trace shows no order write");
            };
          }
        );

        When("the verdict call runs", async () => {
          result = await judge.call(
            judgeInput({
              messages: [
                tracedMessage("user", "write the order"),
                tracedMessage("assistant", "I wrote it", TRACE_A),
              ],
              currentTurn: 1,
            })
          );
        });

        Then(
          "the settle-wait completes before the verdict prompt is built",
          () => {
            expect(invocations).toHaveLength(2);
            expect(userMessageContent(invocations[0])).not.toContain(
              "db.write_orders"
            );
            expect(invocations[1].toolChoice).toEqual({
              type: "tool",
              toolName: "finish_test",
            });
          }
        );

        And(
          "the fetched spans are present in the verdict's trace digest",
          () => {
            expect(userMessageContent(invocations[1])).toContain(
              "db.write_orders"
            );
            expect(result).not.toBeNull();
            expect(result?.success).toBe(false);
            expect(result?.reasoning).toBe("the trace shows no order write");
          }
        );
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "Fetch failure produces a synthetic error span and inconclusive criteria guidance",
      ({ Given, When, Then, And }) => {
        let judge: ReturnType<typeof judgeAgent>;
        let capturedParams: InvokeLLMParams | undefined;
        let input: AgentInput;

        Given("the remote trace fetch times out", () => {
          const api = fakeTraceApi({ [TRACE_A]: ["404"] });
          const collector = new JudgeSpanCollector();
          const fetcher = new RemoteTraceFetcher({
            fetchFn: api.fetchFn,
            pollIntervalMs: 2,
          });
          judge = makeJudge({ collector, fetcher });
          judge.invokeLLM = async (params) => {
            capturedParams = params;
            return finishTest("success");
          };
          input = judgeInput({
            messages: [
              tracedMessage("user", "write the order"),
              tracedMessage("assistant", "I wrote it", TRACE_A),
            ],
            currentTurn: 4,
            scenarioConfigExtra: { traceWaitTimeoutMs: 30 },
          });
        });

        When("the judge issues its verdict", async () => {
          await judge.call(input);
        });

        Then(
          "the trace digest contains a span named langwatch.span_collection.error with the failure reason",
          () => {
            const content = userMessageContent(capturedParams);
            expect(content).toContain("langwatch.span_collection.error");
            expect(content).toContain("Timed out after 30ms");
          }
        );

        And(
          "the judge system prompt instructs that trace-dependent criteria must not pass on transcript claims alone",
          () => {
            expect(systemMessageContent(capturedParams)).toContain(
              REMOTE_TRACE_RULE
            );
          }
        );
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "A fractional wait budget does not break the fetch",
      ({ Given, When, Then }) => {
        let api: ReturnType<typeof fakeTraceApi>;
        let collector: JudgeSpanCollector;
        let fetcher: RemoteTraceFetcher;

        Given(
          "the settle-wait budget is a fractional number of milliseconds",
          () => {
            api = fakeTraceApi({
              [TRACE_A]: [[toolSpan(TRACE_A, "c000000000000010")]],
            });
            collector = new JudgeSpanCollector();
            fetcher = new RemoteTraceFetcher({
              fetchFn: api.fetchFn,
              pollIntervalMs: 1,
            });
          }
        );

        When("the judge settle-waits for the remote trace", async () => {
          // A computed budget (for example 1.25 * p95 + 5s) is fractional,
          // and AbortSignal.timeout rejects non-integer delays.
          await fetcher.settleWait({
            threadId: THREAD_ID,
            traceIds: [TRACE_A],
            collector,
            langwatch: LANGWATCH,
            timeoutMs: 25_242.1875,
          });
        });

        Then(
          "the trace settles normally without a synthetic error span",
          () => {
            const names = collector
              .getSpansForThread(THREAD_ID)
              .map((span) => span.name);
            expect(names).toContain("db.write_orders");
            expect(names).not.toContain("langwatch.span_collection.error");
          }
        );
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "A poll in flight at the deadline still yields the timeout reason",
      ({ Given, When, Then }) => {
        let collector: JudgeSpanCollector;
        let fetcher: RemoteTraceFetcher;

        Given("a remote trace that never arrives within the budget", () => {
          collector = new JudgeSpanCollector();
          // A fake that honors the request abort signal and answers slower
          // than the settle budget, so the deadline expires mid-poll. The
          // request signal must NOT fire (it is a fixed per-request bound,
          // not the settle budget), so the poll completes and the deadline
          // branch records the honest timeout reason.
          const fetchFn: typeof fetch = (_input, init) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(
                () => resolve(jsonResponse({ trace_id: TRACE_A, spans: [] })),
                30
              );
              init?.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(
                  new DOMException(
                    "The operation was aborted due to timeout",
                    "TimeoutError"
                  )
                );
              });
            });
          fetcher = new RemoteTraceFetcher({ fetchFn, pollIntervalMs: 1 });
        });

        When(
          "the settle-wait deadline expires while a poll is in flight",
          async () => {
            await fetcher.settleWait({
              threadId: THREAD_ID,
              traceIds: [TRACE_A],
              collector,
              langwatch: LANGWATCH,
              timeoutMs: 10,
            });
          }
        );

        Then(
          "the synthetic error span reports that no agent spans arrived rather than an aborted fetch",
          () => {
            const errorSpan = collector
              .getSpansForThread(THREAD_ID)
              .find((span) => span.name === "langwatch.span_collection.error");
            expect(errorSpan).toBeDefined();
            const reason = String(
              errorSpan?.attributes["langwatch.span_collection.error.reason"]
            );
            expect(reason).toContain("no agent spans arrived");
            expect(reason).not.toContain("aborted");
          }
        );
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "A failed poll retries until the deadline instead of failing the trace",
      ({ Given, When, Then }) => {
        let collector: JudgeSpanCollector;
        let fetcher: RemoteTraceFetcher;

        Given(
          "the first trace fetch fails and a later fetch returns the complete trace",
          () => {
            collector = new JudgeSpanCollector();
            let callCount = 0;
            const fetchFn: typeof fetch = async () => {
              callCount++;
              if (callCount === 1) throw new Error("transient blip");
              return new Response(
                JSON.stringify({
                  trace_id: TRACE_A,
                  spans: [toolSpan(TRACE_A, "c000000000000010")],
                }),
                { status: 200 }
              );
            };
            fetcher = new RemoteTraceFetcher({ fetchFn, pollIntervalMs: 1 });
          }
        );

        When("the judge settle-waits for the remote trace", async () => {
          await fetcher.settleWait({
            threadId: THREAD_ID,
            traceIds: [TRACE_A],
            collector,
            langwatch: LANGWATCH,
            timeoutMs: 5_000,
          });
        });

        Then(
          "the trace settles normally without a synthetic error span",
          () => {
            const names = collector
              .getSpansForThread(THREAD_ID)
              .map((span) => span.name);
            expect(names).toContain("db.write_orders");
            expect(names).not.toContain("langwatch.span_collection.error");
          }
        );
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "A voluntary inconclusive verdict is terminal when no remote trace ever settled",
      ({ Given, When, Then }) => {
        let judge: ReturnType<typeof makeJudge>;
        let result: Awaited<ReturnType<ReturnType<typeof makeJudge>["call"]>>;

        Given(
          "remote trace fetching is enabled and every trace terminally failed to settle",
          () => {
            const api = fakeTraceApi({ [TRACE_A]: ["404"] });
            const fetcher = new RemoteTraceFetcher({
              fetchFn: api.fetchFn,
              pollIntervalMs: 1,
            });
            judge = makeJudge({
              collector: new JudgeSpanCollector(),
              fetcher,
            });
            judge.invokeLLM = async (params) => {
              // Honor the offered toolset: the decision volunteers
              // make_verdict, the verdict answers inconclusive.
              if (!("finish_test" in (params.tools ?? {}))) {
                return mockLLMResult("make_verdict", {});
              }
              return mockLLMResult("finish_test", {
                criteria: {
                  the_agent_writes_the_order_to_the_database: "inconclusive",
                },
                reasoning: "No trace evidence arrived for the write.",
                verdict: "inconclusive",
              });
            };
          }
        );

        When(
          "the judge volunteers a verdict and it comes back inconclusive",
          async () => {
            result = await judge.call(
              judgeInput({
                messages: [
                  tracedMessage("user", "place the order", TRACE_A),
                  tracedMessage("assistant", "order placed"),
                ],
                currentTurn: 1,
                maxTurns: 5,
                scenarioConfigExtra: { traceWaitTimeoutMs: 30 },
              })
            );
          }
        );

        Then(
          "the verdict is final and the conversation does not continue",
          () => {
            // A continuing judge returns null; a terminal verdict returns
            // the result, and an inconclusive criterion cannot pass.
            expect(result).not.toBeNull();
            const judgeResult = result as JudgeResult;
            expect(judgeResult.success).toBe(false);
          }
        );
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "Remote spans deduplicate against locally collected spans",
      ({ Given, When, Then, And }) => {
        let collector: JudgeSpanCollector;
        let fetcher: RemoteTraceFetcher;

        Given(
          "the scenario's own spans were exported to LangWatch and also collected locally",
          () => {
            collector = new JudgeSpanCollector();
            collector.onEnd(
              createSpan({
                spanId: "b000000000000001",
                name: "local.op",
                startTime: [1_700_000_000, 0],
                endTime: [1_700_000_001, 0],
                attributes: { "langwatch.thread.id": THREAD_ID },
              })
            );
            const api = fakeTraceApi({
              [TRACE_A]: [
                [
                  toolSpan(TRACE_A, "b000000000000001"),
                  toolSpan(TRACE_A, "b000000000000002"),
                  {
                    ...toolSpan(TRACE_A, "b000000000000003"),
                    name: "langwatch.scenario.run",
                  },
                  {
                    ...toolSpan(TRACE_A, "b000000000000004"),
                    name: "langwatch.judge.call",
                  },
                  {
                    ...toolSpan(TRACE_A, "b000000000000005"),
                    name: "langwatch.user_simulator.call",
                  },
                ],
              ],
            });
            fetcher = new RemoteTraceFetcher({
              fetchFn: api.fetchFn,
              pollIntervalMs: 1,
            });
          }
        );

        When(
          "remote traces are merged into the judge span collector",
          async () => {
            await fetcher.settleWait({
              threadId: THREAD_ID,
              traceIds: [TRACE_A],
              collector,
              langwatch: LANGWATCH,
              timeoutMs: 5_000,
            });
          }
        );

        Then("spans already collected locally are not added twice", () => {
          const spans = collector.getSpansForThread(THREAD_ID);
          const withLocalId = spans.filter(
            (s) => s.spanContext().spanId === "b000000000000001"
          );
          expect(withLocalId).toHaveLength(1);
          expect(withLocalId[0].name).toBe("local.op");
        });

        And("scenario infrastructure spans are filtered out", () => {
          const names = collector
            .getSpansForThread(THREAD_ID)
            .map((s) => s.name)
            .sort();
          expect(names).toEqual(["db.write_orders", "local.op"]);
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "Remote fetching is off by default",
      ({ Given, When, Then, And }) => {
        let api: ReturnType<typeof fakeTraceApi>;
        let judge: ReturnType<typeof judgeAgent>;
        let capturedParams: InvokeLLMParams | undefined;

        Given("a scenario without fetch_remote_traces configured", () => {
          api = fakeTraceApi({
            [TRACE_A]: [[toolSpan(TRACE_A, "b000000000000002")]],
          });
          const collector = new JudgeSpanCollector();
          collector.onEnd(
            createSpan({
              spanId: "b000000000000001",
              name: "local.op",
              startTime: [1_700_000_000, 0],
              endTime: [1_700_000_001, 0],
              attributes: { "langwatch.thread.id": THREAD_ID },
            })
          );
          const fetcher = new RemoteTraceFetcher({
            fetchFn: api.fetchFn,
            pollIntervalMs: 1,
          });
          judge = makeJudge({ collector, fetcher });
          judge.invokeLLM = async (params) => {
            capturedParams = params;
            return finishTest("success");
          };
        });

        When("the scenario runs", async () => {
          await judge.call(
            judgeInput({
              messages: [
                tracedMessage("user", "write the order"),
                tracedMessage("assistant", "I wrote it", TRACE_A),
              ],
              currentTurn: 4,
              scenarioConfigExtra: { fetchRemoteTraces: undefined },
            })
          );
        });

        Then("no remote trace fetch happens", () => {
          expect(api.requestedTraceIds).toHaveLength(0);
        });

        And("the judge sees only locally collected spans", () => {
          const content = userMessageContent(capturedParams);
          expect(content).toContain("local.op");
          expect(content).not.toContain("db.write_orders");
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "Spans started by the scenario process never count as remote evidence",
      ({ Given, When, Then, And }) => {
        let collector: JudgeSpanCollector;
        let fetcher: RemoteTraceFetcher;
        let allSettled = true;

        Given(
          "the platform echoes back spans the scenario process itself started, including spans whose ancestor chain crosses the still-open turn span and model-call spans that carry no thread id",
          () => {
            collector = new JudgeSpanCollector();
            // The still-open turn span never reaches onEnd; its descendants
            // (a judge call and an untagged model-call span) do, but their
            // ancestor chain is broken for the per-thread view. onStart saw
            // all three.
            for (const spanId of [
              "c000000000000001",
              "c000000000000002",
              "c000000000000003",
            ]) {
              collector.onStart({
                spanContext: () => ({ traceId: TRACE_A, spanId }),
              } as never);
            }
            const api = fakeTraceApi({
              [TRACE_A]: [
                [
                  {
                    ...toolSpan(TRACE_A, "c000000000000002"),
                    name: "_JudgeAgent.call",
                    parent_id: "c000000000000001",
                  },
                  {
                    ...toolSpan(TRACE_A, "c000000000000003"),
                    name: "ai.generateText",
                    parent_id: "c000000000000002",
                  },
                ],
              ],
            });
            fetcher = new RemoteTraceFetcher({
              fetchFn: api.fetchFn,
              pollIntervalMs: 1,
            });
          }
        );

        When("the judge settle-waits for the remote trace", async () => {
          ({ allSettled } = await fetcher.settleWait({
            threadId: THREAD_ID,
            traceIds: [TRACE_A],
            collector,
            langwatch: LANGWATCH,
            timeoutMs: 30,
          }));
        });

        Then("none of the echoed spans count as remote", () => {
          expect(allSettled).toBe(false);
          expect(fetcher.noneSettled(THREAD_ID, [TRACE_A])).toBe(true);
        });

        And("the deadline reason reports that no agent spans arrived", () => {
          const errorSpan = collector
            .getSpansForThread(THREAD_ID)
            .find((s) => s.name === "langwatch.span_collection.error");
          expect(
            errorSpan?.attributes["langwatch.span_collection.error.reason"]
          ).toContain("no agent spans arrived");
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "A finished scenario releases its traces from the process-span registry",
      ({ Given, When, Then, And }) => {
        let collector: JudgeSpanCollector;
        const OTHER_THREAD = "scenariothread_other";

        Given(
          "the judge settle-waited for a trace whose local spans never ended or never carried the thread id",
          async () => {
            collector = new JudgeSpanCollector();
            // The local echo's span never reaches onEnd, so ended-span
            // discovery cannot find TRACE_A at clear time; the settle-wait's
            // claim is the only route to it.
            collector.onStart({
              spanContext: () => ({
                traceId: TRACE_A,
                spanId: "c000000000000001",
              }),
            } as never);
            const api = fakeTraceApi({
              [TRACE_A]: [
                [
                  {
                    ...toolSpan(TRACE_A, "c000000000000001"),
                    name: "_JudgeAgent.call",
                  },
                ],
              ],
            });
            const fetcher = new RemoteTraceFetcher({
              fetchFn: api.fetchFn,
              pollIntervalMs: 1,
            });
            await fetcher.settleWait({
              threadId: THREAD_ID,
              traceIds: [TRACE_A],
              collector,
              langwatch: LANGWATCH,
              timeoutMs: 30,
            });
            collector.onStart({
              spanContext: () => ({
                traceId: TRACE_B,
                spanId: "c000000000000002",
              }),
            } as never);
            collector.claimTraces(OTHER_THREAD, [TRACE_B]);
          }
        );

        When("the scenario run completes and its thread is cleared", () => {
          collector.clearSpansForThread(THREAD_ID);
        });

        Then("the process-span registry no longer holds that trace", () => {
          expect(collector.isProcessSpan(TRACE_A, "c000000000000001")).toBe(
            false
          );
        });

        And("traces claimed by other threads stay registered", () => {
          expect(collector.isProcessSpan(TRACE_B, "c000000000000002")).toBe(
            true
          );
        });
      }
    );

    // -----------------------------------------------------------------------
    /**
     * Stub fetcher for the wait-extension scenarios: the first settle never
     * settles, the extension settles everything. Records the budgets.
     */
    class ExtensionStubFetcher {
      settleBudgets: number[] = [];
      extendBudgets: number[] = [];
      private extended = false;
      async settleWait({ timeoutMs }: { timeoutMs: number }) {
        this.settleBudgets.push(timeoutMs);
        return { allSettled: false };
      }
      async extendSettle({ timeoutMs }: { timeoutMs: number }) {
        this.extended = true;
        this.extendBudgets.push(timeoutMs);
        return { allSettled: true };
      }
      noneSettled(): boolean {
        return !this.extended;
      }
      recordMissingTraceIds(): void {}
      clearForThread(): void {}
    }

    function waitFlowJudge(collector: JudgeSpanCollector) {
      const stub = new ExtensionStubFetcher();
      const judge = makeJudge({
        collector,
        fetcher: stub as unknown as RemoteTraceFetcher,
      });
      const calls: InvokeLLMParams[] = [];
      judge.invokeLLM = async (params) => {
        calls.push(params);
        return calls.length === 1
          ? mockLLMResult("wait_for_traces", {})
          : finishTest("success");
      };
      return { stub, judge, calls };
    }

    Scenario(
      "The judge may wait once more when the traces are incomplete",
      ({ Given, When, Then, And }) => {
        let stub: ExtensionStubFetcher;
        let judge: ReturnType<typeof judgeAgent>;
        let calls: InvokeLLMParams[];

        Given("the settle-wait ended with an incomplete trace", () => {
          ({ stub, judge, calls } = waitFlowJudge(new JudgeSpanCollector()));
        });

        When("the verdict call runs", async () => {
          await judge.call(
            judgeInput({
              messages: [
                tracedMessage("user", "write the order"),
                tracedMessage("assistant", "I wrote it", TRACE_A),
              ],
              scenarioConfigExtra: { traceWaitExtensionMs: 7_000 },
              judgmentRequest: {},
            })
          );
        });

        Then("a wait_for_traces tool is offered alongside finish_test", () => {
          expect(Object.keys(calls[0].tools ?? {})).toEqual(
            expect.arrayContaining(["wait_for_traces", "finish_test"])
          );
          expect(calls[0].toolChoice).toBe("required");
        });

        And(
          "calling it settle-waits once more under the extension budget",
          () => {
            expect(stub.extendBudgets).toEqual([7_000]);
          }
        );

        And(
          "a trace that settles during the extra wait loses its synthetic error span",
          async () => {
            // The retraction itself is the real fetcher's contract: a failed
            // first wait records the error span, the extension settles the
            // trace and removes it.
            const collector = new JudgeSpanCollector();
            const childOnly = [
              {
                ...toolSpan(TRACE_A, "b000000000000002"),
                parent_id: "b000000000000001",
              },
            ];
            const complete = [
              toolSpan(TRACE_A, "b000000000000001"),
              {
                ...toolSpan(TRACE_A, "b000000000000002"),
                parent_id: "b000000000000001",
              },
            ];
            let traceIsComplete = false;
            const fetchFn: typeof fetch = async () =>
              jsonResponse({
                trace_id: TRACE_A,
                spans: traceIsComplete ? complete : childOnly,
              });
            const realFetcher = new RemoteTraceFetcher({
              fetchFn,
              pollIntervalMs: 1,
            });
            const settleTarget = {
              threadId: THREAD_ID,
              traceIds: [TRACE_A],
              collector,
              langwatch: LANGWATCH,
            };
            await realFetcher.settleWait({ ...settleTarget, timeoutMs: 10 });
            expect(
              collector
                .getSpansForThread(THREAD_ID)
                .some((s) => s.name === "langwatch.span_collection.error")
            ).toBe(true);

            traceIsComplete = true;
            const second = await realFetcher.extendSettle({
              ...settleTarget,
              timeoutMs: 5_000,
            });
            expect(second.allSettled).toBe(true);
            expect(
              collector
                .getSpansForThread(THREAD_ID)
                .some((s) => s.name === "langwatch.span_collection.error")
            ).toBe(false);
          }
        );
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "The extra wait is available once",
      ({ Given, When, Then, And }) => {
        let judge: ReturnType<typeof judgeAgent>;
        let calls: InvokeLLMParams[];

        Given("the judge already used its wait_for_traces extension", () => {
          ({ judge, calls } = waitFlowJudge(new JudgeSpanCollector()));
        });

        When("the verdict re-enters after the extra wait", async () => {
          await judge.call(
            judgeInput({
              messages: [
                tracedMessage("user", "write the order"),
                tracedMessage("assistant", "I wrote it", TRACE_A),
              ],
              judgmentRequest: {},
            })
          );
          expect(calls).toHaveLength(2);
        });

        Then("the wait_for_traces tool is not offered", () => {
          expect(Object.keys(calls[1].tools ?? {})).not.toContain(
            "wait_for_traces"
          );
        });

        And("the verdict call is pinned to finish_test", () => {
          expect(calls[1].toolChoice).toEqual({
            type: "tool",
            toolName: "finish_test",
          });
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "The trace wait budget defaults to 30 seconds",
      ({ Given, When, Then, And }) => {
        let stub: ExtensionStubFetcher;
        let judge: ReturnType<typeof judgeAgent>;

        Given(
          "a scenario with fetch_remote_traces enabled and no trace_wait_timeout configured",
          () => {
            ({ stub, judge } = waitFlowJudge(new JudgeSpanCollector()));
          }
        );

        When("the judge settle-waits for the remote traces", async () => {
          await judge.call(
            judgeInput({
              messages: [
                tracedMessage("user", "write the order"),
                tracedMessage("assistant", "I wrote it", TRACE_A),
              ],
              scenarioConfigExtra: { traceWaitTimeoutMs: undefined },
              judgmentRequest: {},
            })
          );
        });

        Then("the settle-wait budget is 30 seconds", () => {
          expect(stub.settleBudgets).toEqual([30_000]);
        });

        And("the extension budget defaults to the resolved wait budget", () => {
          expect(stub.extendBudgets).toEqual([30_000]);
        });
      }
    );
  },
  { includeTags: [["unit"]] }
);

// ---------------------------------------------------------------------------
// Supplementary implementation-level coverage (not named spec scenarios)
// ---------------------------------------------------------------------------

describe("when a wait budget is not a finite positive number", () => {
  // ScenarioConfig is a plain interface, so nothing rejects Infinity or NaN
  // before it reaches the fetcher, where it becomes a deadline the settle
  // loop can never reach.
  it.each([
    ["Infinity", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
    ["zero", 0],
    ["a negative value", -1],
  ])("ignores %s and falls back to the 30 second default", async (_label, bad) => {
    const stub = new (class {
      settleBudgets: number[] = [];
      async settleWait({ timeoutMs }: { timeoutMs: number }) {
        this.settleBudgets.push(timeoutMs);
        return { allSettled: true };
      }
      async extendSettle() {
        return { allSettled: true };
      }
      noneSettled(): boolean {
        return false;
      }
      recordMissingTraceIds(): void {}
      clearForThread(): void {}
    })();
    const judge = makeJudge({
      collector: new JudgeSpanCollector(),
      fetcher: stub as unknown as RemoteTraceFetcher,
    });
    judge.invokeLLM = async () => finishTest("success");

    await judge.call(
      judgeInput({
        messages: [
          tracedMessage("user", "write the order"),
          tracedMessage("assistant", "I wrote it", TRACE_A),
        ],
        scenarioConfigExtra: { traceWaitTimeoutMs: bad },
        judgmentRequest: {},
      })
    );

    expect(stub.settleBudgets).toEqual([30_000]);
  });
});

describe("project-wide remote trace defaults", () => {
  it("accepts the fields in the scenario.config.js schema", () => {
    const parsed = scenarioProjectConfigSchema.parse({
      fetchRemoteTraces: true,
      traceWaitTimeoutMs: 30_000,
    });
    expect(parsed.fetchRemoteTraces).toBe(true);
    expect(parsed.traceWaitTimeoutMs).toBe(30_000);
  });

  it("applies the project default when the scenario config does not set it", async () => {
    vi.mocked(getProjectConfig).mockResolvedValueOnce({
      defaultModel: { model: "openai/gpt-5-mini", temperature: 0 },
      fetchRemoteTraces: true,
    } as never);
    const api = fakeTraceApi({
      [TRACE_A]: [[toolSpan(TRACE_A, "b000000000000001")]],
    });
    const judge = makeJudge({
      collector: new JudgeSpanCollector(),
      fetcher: new RemoteTraceFetcher({ fetchFn: api.fetchFn, pollIntervalMs: 1 }),
    });
    let callCount = 0;
    judge.invokeLLM = async () => {
      callCount += 1;
      return callCount === 1
        ? mockLLMResult("make_verdict", {})
        : finishTest("success");
    };

    await judge.call(
      judgeInput({
        messages: [tracedMessage("assistant", "ok", TRACE_A)],
        currentTurn: 1,
        scenarioConfigExtra: { fetchRemoteTraces: undefined },
      })
    );

    expect(api.requestedTraceIds).toEqual([TRACE_A]);
  });

  it("lets the per-run scenario config win over the project default", async () => {
    vi.mocked(getProjectConfig).mockResolvedValueOnce({
      defaultModel: { model: "openai/gpt-5-mini", temperature: 0 },
      fetchRemoteTraces: true,
    } as never);
    const api = fakeTraceApi({ [TRACE_A]: ["404"] });
    const judge = makeJudge({
      collector: new JudgeSpanCollector(),
      fetcher: new RemoteTraceFetcher({ fetchFn: api.fetchFn, pollIntervalMs: 1 }),
    });
    let callCount = 0;
    judge.invokeLLM = async () => {
      callCount += 1;
      return callCount === 1
        ? mockLLMResult("make_verdict", {})
        : finishTest("success");
    };

    await judge.call(
      judgeInput({
        messages: [tracedMessage("assistant", "ok", TRACE_A)],
        currentTurn: 1,
        scenarioConfigExtra: { fetchRemoteTraces: false },
      })
    );

    expect(api.requestedTraceIds).toHaveLength(0);
  });
});

describe("judge system prompt remote trace rules", () => {
  it("carries the verdict rule only when remote fetching is enabled", async () => {
    async function promptFor(scenarioConfigExtra: Record<string, unknown>) {
      const collector = new JudgeSpanCollector();
      const fetcher = new RemoteTraceFetcher({
        fetchFn: fakeTraceApi({}).fetchFn,
        pollIntervalMs: 1,
      });
      const judge = makeJudge({ collector, fetcher });
      let params: InvokeLLMParams | undefined;
      judge.invokeLLM = async (p) => {
        params = p;
        return finishTest("success");
      };
      await judge.call(
        judgeInput({
          messages: [tracedMessage("user", "hello")],
          currentTurn: 1,
          judgmentRequest: {} as AgentInput["judgmentRequest"],
          scenarioConfigExtra,
        })
      );
      return systemMessageContent(params);
    }

    const enabled = await promptFor({});
    const disabled = await promptFor({ fetchRemoteTraces: undefined });

    expect(enabled).toContain(REMOTE_TRACE_RULE);
    expect(disabled).not.toContain(REMOTE_TRACE_RULE);
  });

  it("tells the decision call that traces are fetched at the verdict", async () => {
    const collector = new JudgeSpanCollector();
    const fetcher = new RemoteTraceFetcher({
      fetchFn: fakeTraceApi({}).fetchFn,
      pollIntervalMs: 1,
    });
    const judge = makeJudge({ collector, fetcher });
    let params: InvokeLLMParams | undefined;
    judge.invokeLLM = async (p) => {
      params = p;
      return mockLLMResult("continue_test", {});
    };

    await judge.call(
      judgeInput({
        messages: [tracedMessage("user", "hello")],
        currentTurn: 1,
      })
    );

    const prompt = systemMessageContent(params);
    expect(prompt).toContain(
      "The agent's execution traces are fetched and verified at the verdict"
    );
    expect(prompt).not.toContain(REMOTE_TRACE_RULE);
  });
});
