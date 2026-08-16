/**
 * Two-phase judge: decision gate then verdict.
 *
 * Binds the @unit scenarios of `specs/judge-two-phase.feature`. Mechanics
 * mirror `judge-agent.test.ts`: `agent.invokeLLM` overridden to capture
 * params and return canned tool calls.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { expect, vi } from "vitest";

import { AgentInput, AgentRole } from "../../../domain";
import { InvokeLLMParams, InvokeLLMResult } from "../../types";
import { judgeAgent } from "../judge-agent";
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
  "judge-two-phase.feature"
);

vi.mock("../../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-5-mini", temperature: 0 },
  }),
}));

const CRITERIA = ["Agent answers the question"];
const CRITERION_KEY = "agent_answers_the_question";

function createInput(overrides?: Partial<AgentInput>): AgentInput {
  return {
    threadId: "two-phase-thread",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ],
    newMessages: [{ role: "assistant", content: "Hi there!" }],
    requestedRole: AgentRole.JUDGE,
    // The overrides come first: the two merged keys below have to win over
    // their whole-object replacements, or a partial scenarioConfig drops the
    // defaults it did not name.
    ...overrides,
    scenarioState: { currentTurn: 1, ...(overrides?.scenarioState as object) },
    scenarioConfig: {
      name: "two-phase test",
      description: "A test scenario",
      maxTurns: 10,
      ...(overrides?.scenarioConfig as object),
    },
  } as AgentInput;
}

function mockLLMResult(toolName: string, input: unknown): InvokeLLMResult {
  return {
    text: "",
    content: [],
    toolCalls: [
      { toolName, input, type: "tool-call" as const, toolCallId: "tc-1" },
    ],
    toolResults: [],
  } as unknown as InvokeLLMResult;
}

function finishResult(
  verdict: "success" | "failure" | "inconclusive",
  reasoning = "Verdict delivered."
): InvokeLLMResult {
  return mockLLMResult("finish_test", {
    criteria: { [CRITERION_KEY]: verdict === "success" ? "true" : "false" },
    reasoning,
    verdict,
  });
}

function createLargeTrace(): ReadableSpan[] {
  return Array.from({ length: 200 }, (_, i) =>
    createSpan({
      spanId: `${i.toString(16).padStart(16, "0")}`,
      name: `operation-${i}`,
      startTime: [1700000000 + i, 0],
      endTime: [1700000000 + i, 100_000_000],
      attributes: {
        "gen_ai.prompt": "a".repeat(200),
        "gen_ai.completion": "b".repeat(200),
        "tool.input": "c".repeat(200),
        "langwatch.thread.id": "two-phase-thread",
      },
    })
  );
}

function makeJudge(spans: ReadableSpan[] = []) {
  const collector = new JudgeSpanCollector();
  for (const span of spans) collector.onEnd(span);
  const agent = judgeAgent({
    criteria: CRITERIA,
    spanCollector: collector,
    maxDiscoverySteps: 3,
  });
  const calls: InvokeLLMParams[] = [];
  return { agent, calls };
}

function schemaShapeKeys(tool: unknown): string[] {
  const inputSchema = (tool as { inputSchema?: { shape?: object } })
    .inputSchema;
  return Object.keys(inputSchema?.shape ?? { unresolved: true });
}

function systemPromptOf(params: InvokeLLMParams | undefined): string {
  const systemMessage = params?.messages?.find(
    (m) => "role" in m && m.role === "system"
  );
  return typeof systemMessage?.content === "string"
    ? systemMessage.content
    : "";
}

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Background, Scenario }) => {
    Background(({ Given }) => {
      Given("a JudgeAgent with success criteria", () => {
        // Each scenario builds its own judge via makeJudge().
      });
    });

    // -----------------------------------------------------------------------
    Scenario(
      "A mid-conversation judge call decides between continuing and judging with argument-free tools",
      ({ Given, When, Then, And }) => {
        const { agent, calls } = makeJudge();
        let result: Awaited<ReturnType<typeof agent.call>>;

        Given(
          "the judge is called mid-conversation without an explicit judgment request",
          () => {
            agent.invokeLLM = async (params) => {
              calls.push(params);
              return mockLLMResult("continue_test", {});
            };
          }
        );

        When("the decision call runs", async () => {
          result = await agent.call(createInput());
        });

        Then("the judge's terminal tools are continue_test and make_verdict", () => {
          expect(result).toBeNull();
          expect(calls).toHaveLength(1);
          expect(Object.keys(calls[0]!.tools ?? {})).toEqual([
            "continue_test",
            "make_verdict",
          ]);
        });

        And("neither decision tool accepts any arguments", () => {
          const tools = calls[0]!.tools ?? {};
          expect(schemaShapeKeys(tools.continue_test)).toEqual([]);
          expect(schemaShapeKeys(tools.make_verdict)).toEqual([]);
        });

        And("finish_test is not offered", () => {
          expect(Object.keys(calls[0]!.tools ?? {})).not.toContain(
            "finish_test"
          );
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "A make_verdict decision leads to exactly one verdict call",
      ({ Given, When, Then, And }) => {
        const { agent, calls } = makeJudge();
        let result: Awaited<ReturnType<typeof agent.call>>;

        Given(
          "the judge decides mid-conversation that enough information has been collected",
          () => {
            agent.invokeLLM = async (params) => {
              calls.push(params);
              return calls.length === 1
                ? mockLLMResult("make_verdict", {})
                : finishResult("success");
            };
          }
        );

        When("the decision call returns make_verdict", async () => {
          result = await agent.call(createInput());
        });

        Then(
          "one verdict call follows with the tool choice pinned to finish_test",
          () => {
            expect(calls).toHaveLength(2);
            expect(calls[1]!.toolChoice).toEqual({
              type: "tool",
              toolName: "finish_test",
            });
          }
        );

        And("the run result comes from the verdict call", () => {
          expect(result).not.toBeNull();
          expect(result!.success).toBe(true);
          expect(result!.reasoning).toBe("Verdict delivered.");
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "A continue decision makes no verdict call",
      ({ Given, When, Then, And }) => {
        const { agent, calls } = makeJudge();
        let result: Awaited<ReturnType<typeof agent.call>>;

        Given("the judge is called mid-conversation", () => {
          agent.invokeLLM = async (params) => {
            calls.push(params);
            return mockLLMResult("continue_test", {});
          };
        });

        When("the decision call returns continue_test", async () => {
          result = await agent.call(createInput());
        });

        Then("no verdict call is made", () => {
          expect(calls).toHaveLength(1);
        });

        And("the conversation continues", () => {
          expect(result).toBeNull();
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "An explicit judgment request goes straight to the verdict call",
      ({ Given, When, Then, And }) => {
        const { agent, calls } = makeJudge();
        let result: Awaited<ReturnType<typeof agent.call>>;

        Given("a judgment request with criteria", () => {
          agent.invokeLLM = async (params) => {
            calls.push(params);
            return finishResult("failure");
          };
        });

        When("the judge is called", async () => {
          result = await agent.call(
            createInput({ judgmentRequest: { criteria: CRITERIA } })
          );
        });

        Then("the first and only LLM call is the verdict call", () => {
          expect(calls).toHaveLength(1);
          expect(calls[0]!.toolChoice).toEqual({
            type: "tool",
            toolName: "finish_test",
          });
          expect(result).not.toBeNull();
        });

        And("finish_test is the only terminal tool offered", () => {
          expect(Object.keys(calls[0]!.tools ?? {})).toEqual(["finish_test"]);
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "The last turn goes straight to the verdict call",
      ({ Given, When, Then }) => {
        const { agent, calls } = makeJudge();
        let result: Awaited<ReturnType<typeof agent.call>>;

        Given("the conversation reached its final turn", () => {
          agent.invokeLLM = async (params) => {
            calls.push(params);
            return finishResult("success");
          };
        });

        When("the judge is called", async () => {
          result = await agent.call(
            createInput({
              scenarioState: { currentTurn: 9 },
            } as Partial<AgentInput>)
          );
        });

        Then("the first and only LLM call is the verdict call", () => {
          expect(calls).toHaveLength(1);
          expect(calls[0]!.toolChoice).toEqual({
            type: "tool",
            toolName: "finish_test",
          });
          expect(result).not.toBeNull();
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "A voluntary verdict of inconclusive continues the conversation",
      ({ Given, When, Then }) => {
        const { agent, calls } = makeJudge();
        let result: Awaited<ReturnType<typeof agent.call>>;

        Given("the judge chose make_verdict mid-conversation", () => {
          agent.invokeLLM = async (params) => {
            calls.push(params);
            return calls.length === 1
              ? mockLLMResult("make_verdict", {})
              : finishResult("inconclusive", "Cannot tell yet.");
          };
        });

        When("the verdict call returns an inconclusive verdict", async () => {
          result = await agent.call(createInput());
        });

        Then("the conversation continues instead of ending", () => {
          expect(calls).toHaveLength(2);
          expect(result).toBeNull();
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "A required verdict of inconclusive is terminal",
      ({ Given, When, Then }) => {
        const { agent, calls } = makeJudge();
        let result: Awaited<ReturnType<typeof agent.call>>;

        Given("the conversation reached its final turn", () => {
          agent.invokeLLM = async (params) => {
            calls.push(params);
            return finishResult("inconclusive", "Max turns reached.");
          };
        });

        When("the verdict call returns an inconclusive verdict", async () => {
          result = await agent.call(
            createInput({
              scenarioState: { currentTurn: 9 },
            } as Partial<AgentInput>)
          );
        });

        Then("the run ends with that verdict", () => {
          expect(result).not.toBeNull();
          expect(result!.success).toBe(false);
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "Below the min_turns floor the judge continues without any LLM call",
      ({ Given, When, Then }) => {
        const { agent, calls } = makeJudge();
        let result: Awaited<ReturnType<typeof agent.call>>;

        Given("a scenario with min_turns above the current turn", () => {
          agent.invokeLLM = async (params) => {
            calls.push(params);
            return mockLLMResult("continue_test", {});
          };
        });

        When(
          "the judge is called without an explicit judgment request",
          async () => {
            result = await agent.call(
              createInput({
                scenarioState: { currentTurn: 1 },
                scenarioConfig: { minTurns: 4 },
              } as Partial<AgentInput>)
            );
          }
        );

        Then("the judge continues without any LLM call", () => {
          expect(calls).toHaveLength(0);
          expect(result).toBeNull();
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "Decision discovery exhaustion forces a terminal verdict",
      ({ Given, When, Then, And }) => {
        const { agent, calls } = makeJudge(createLargeTrace());
        let result: Awaited<ReturnType<typeof agent.call>>;

        Given("a large trace puts the decision call into discovery mode", () => {
          agent.invokeLLM = async (params) => {
            calls.push(params);
            // The first (decision) completion carries only discovery calls;
            // the second is the pinned verdict.
            return calls.length === 1
              ? mockLLMResult("expand_trace", {
                  span_ids: ["0000000000000000"],
                })
              : finishResult("inconclusive", "Could not converge.");
          };
        });

        When(
          "the decision loop exhausts its steps without a decision",
          async () => {
            result = await agent.call(createInput());
          }
        );

        Then("a verdict call follows", () => {
          expect(calls).toHaveLength(2);
          expect(calls[1]!.toolChoice).toEqual({
            type: "tool",
            toolName: "finish_test",
          });
        });

        And("its verdict is terminal even when inconclusive", () => {
          expect(result).not.toBeNull();
          expect(result!.success).toBe(false);
        });
      }
    );

    // -----------------------------------------------------------------------
    Scenario(
      "The decision prompt defers judgment and leans towards continuing",
      ({ Given, When, Then, And }) => {
        const { agent, calls } = makeJudge();

        Given("the decision call is being prepared", () => {
          agent.invokeLLM = async (params) => {
            calls.push(params);
            return mockLLMResult("continue_test", {});
          };
        });

        When("the system prompt is built", async () => {
          await agent.call(createInput());
        });

        Then("it instructs the judge not to decide pass or fail yet", () => {
          expect(systemPromptOf(calls[0])).toContain(
            "Do not decide whether the criteria pass or fail now"
          );
        });

        And(
          "it instructs the judge to lean towards continuing while the conversation is short",
          () => {
            expect(systemPromptOf(calls[0])).toContain(
              "while the conversation is still short, lean towards continuing"
            );
          }
        );
      }
    );
  },
  { includeTags: [["unit"]] }
);
