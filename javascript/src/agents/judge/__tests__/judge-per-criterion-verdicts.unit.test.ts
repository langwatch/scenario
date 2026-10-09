/**
 * Per-criterion judge verdicts.
 *
 * Binds the @unit scenarios of `specs/judge-per-criterion-verdicts.feature`.
 * The judge runs for real with only `invokeLLM` replaced; the provider
 * scenarios drive `createLLMInvoker` with a fake text generator.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";
import { z } from "zod/v4";

import {
  AgentAdapter,
  AgentRole,
  type AgentInput,
  type AgentReturnTypes,
  UserSimulatorAgentAdapter,
} from "../../../domain";
import {
  ScenarioEventType,
  type ScenarioRunFinishedEvent,
} from "../../../events/schema";
import { ScenarioExecution } from "../../../execution/scenario-execution";
import { Logger } from "../../../utils/logger";
import { createLLMInvoker } from "../../llm-invoker.factory";
import { InvokeLLMParams, InvokeLLMResult } from "../../types";
import { criteriaParamNames } from "../../utils";
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
  "judge-per-criterion-verdicts.feature"
);

vi.mock("../../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-5-mini", temperature: 0 },
  }),
}));

type Status = "passed" | "failed" | "inconclusive";

const CRITERIA = [
  "Agent greets the user",
  "The agent must not reveal the account password",
];
const KEYS = criteriaParamNames({ criteria: CRITERIA });

function toolCall(toolName: string, input: unknown): InvokeLLMResult {
  return {
    text: "",
    content: [],
    toolCalls: [{ toolName, input, type: "tool-call", toolCallId: "tc-1" }],
    toolResults: [],
  } as unknown as InvokeLLMResult;
}

function finishWith(statuses: (Status | undefined)[]): InvokeLLMResult {
  const criteria: Record<string, unknown> = {};
  statuses.forEach((status, i) => {
    if (!status) return;
    criteria[KEYS[i]!] = {
      requirement: `Requirement ${i + 1}`,
      reasoning: `Reasoning ${i + 1}`,
      status,
    };
  });
  return toolCall("finish_test", { criteria, reasoning: "Summary." });
}

function createInput(overrides?: Partial<AgentInput>): AgentInput {
  return {
    threadId: "per-criterion-thread",
    messages: [
      { role: "user", content: "Hello, what is my password?" },
      { role: "assistant", content: "Hi! I cannot share passwords." },
    ],
    newMessages: [],
    requestedRole: AgentRole.JUDGE,
    ...overrides,
    scenarioState: { currentTurn: 1 },
    scenarioConfig: {
      name: "per-criterion test",
      description: "A user asks for their password",
      maxTurns: 10,
    },
  } as AgentInput;
}

function makeJudge(criteria: string[] = CRITERIA) {
  const agent = judgeAgent({ criteria, spanCollector: new JudgeSpanCollector() });
  const calls: InvokeLLMParams[] = [];
  return { agent, calls };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walking a JSON schema
type JsonObject = Record<string, any>;

function finishTestSchema(params: InvokeLLMParams): Record<string, unknown> {
  const tool = (params.tools as Record<string, { inputSchema: unknown }>)
    .finish_test!;
  return z.toJSONSchema(tool.inputSchema as z.ZodType) as Record<
    string,
    unknown
  >;
}

function systemPrompt(params: InvokeLLMParams): string {
  const first = params.messages![0]!;
  return typeof first.content === "string" ? first.content : "";
}

class ScriptedAgent extends AgentAdapter {
  role = AgentRole.AGENT;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return { role: "assistant" as const, content: "Hi! I cannot share passwords." };
  }
}

class ScriptedUser extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return "What is my password?";
  }
}

const silentLogger = {
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Background, Scenario }) => {
    Background(({ Given }) => {
      Given("a JudgeAgent with success criteria", () => {
        // Each scenario builds its own judge over CRITERIA.
      });
    });

    Scenario(
      "The verdict tool asks for a requirement, a reasoning and a status per criterion",
      ({ Given, When, Then, And }) => {
        const { agent, calls } = makeJudge();
        let schema: Record<string, unknown>;

        Given("a judgment request with two criteria", () => {
          agent.invokeLLM = async (params) => {
            calls.push(params);
            return finishWith(["passed", "passed"]);
          };
        });

        When("the verdict call runs", async () => {
          await agent.call(createInput({ judgmentRequest: { criteria: CRITERIA } }));
          schema = finishTestSchema(calls[0]!);
        });

        Then("the finish_test schema has one entry per criterion", () => {
          const criteria = (schema.properties as JsonObject).criteria as JsonObject;
          expect(Object.keys(criteria.properties)).toEqual(KEYS);
        });

        And(
          "each entry declares requirement, reasoning and status in that order",
          () => {
            const criteria = (schema.properties as JsonObject).criteria as JsonObject;
            for (const key of KEYS) {
              expect(Object.keys(criteria.properties[key].properties)).toEqual([
                "requirement",
                "reasoning",
                "status",
              ]);
            }
          }
        );

        And("status is one of passed, failed or inconclusive", () => {
          const criteria = (schema.properties as JsonObject).criteria as JsonObject;
          expect(criteria.properties[KEYS[0]!].properties.status.enum).toEqual([
            "passed",
            "failed",
            "inconclusive",
          ]);
        });

        And("the tool has no overall verdict field", () => {
          expect(Object.keys(schema.properties as object)).toEqual([
            "criteria",
            "reasoning",
          ]);
        });
      }
    );

    Scenario(
      "Each criterion's own reasoning reaches the result in declared order",
      ({ Given, When, Then, And }) => {
        const { agent } = makeJudge();
        let result: Awaited<ReturnType<typeof agent.call>>;

        Given("a judgment request with two criteria", () => {
          agent.invokeLLM = async () => {
            // Answered in reverse order: the result must follow the scenario.
            return toolCall("finish_test", {
              criteria: {
                [KEYS[1]!]: {
                  requirement: "The agent keeps the password secret",
                  reasoning: "It refused to share it.",
                  status: "passed",
                },
                [KEYS[0]!]: {
                  requirement: "The agent greets the user",
                  reasoning: "It said hi.",
                  status: "passed",
                },
              },
              reasoning: "Both passed.",
            });
          };
        });

        When(
          "the verdict call returns a status and a reasoning for each criterion",
          async () => {
            result = await agent.call(
              createInput({ judgmentRequest: { criteria: CRITERIA } })
            );
          }
        );

        Then(
          "the result lists both criteria in the order the scenario declared them",
          () => {
            expect(result!.criteria!.map((c) => c.criterion)).toEqual(CRITERIA);
          }
        );

        And("each entry carries its own requirement, status and reasoning", () => {
          expect(result!.criteria).toEqual([
            {
              criterion: CRITERIA[0],
              requirement: "The agent greets the user",
              status: "passed",
              reasoning: "It said hi.",
            },
            {
              criterion: CRITERIA[1],
              requirement: "The agent keeps the password secret",
              status: "passed",
              reasoning: "It refused to share it.",
            },
          ]);
        });
      }
    );

    Scenario(
      "The run passes only when every criterion passed",
      ({ Given, When, Then, And }) => {
        const { agent } = makeJudge();
        let result: Awaited<ReturnType<typeof agent.call>>;

        Given("a judgment request with two criteria", () => {
          agent.invokeLLM = async () => finishWith(["passed", "inconclusive"]);
        });

        When(
          "the verdict call marks one criterion passed and one inconclusive",
          async () => {
            result = await agent.call(
              createInput({ judgmentRequest: { criteria: CRITERIA } })
            );
          }
        );

        Then("the run fails", () => {
          expect(result!.success).toBe(false);
        });

        And("the inconclusive criterion is listed as unmet and as inconclusive", () => {
          expect(result!.unmetCriteria).toEqual([CRITERIA[1]]);
          expect(result!.inconclusiveCriteria).toEqual([CRITERIA[1]]);
        });

        And("its entry in the per-criterion result has status inconclusive", () => {
          expect(result!.criteria![1]!.status).toBe("inconclusive");
        });
      }
    );

    Scenario(
      "A criterion the judge left out fails closed",
      ({ Given, When, Then, And }) => {
        const { agent } = makeJudge();
        let result: Awaited<ReturnType<typeof agent.call>>;

        Given("a judgment request with two criteria", () => {
          agent.invokeLLM = async () => finishWith(["passed", undefined]);
        });

        When("the verdict call answers only the first criterion", async () => {
          result = await agent.call(
            createInput({ judgmentRequest: { criteria: CRITERIA } })
          );
        });

        Then("the second criterion is listed as unmet", () => {
          expect(result!.unmetCriteria).toEqual([CRITERIA[1]]);
          expect(result!.success).toBe(false);
        });

        And("its entry in the per-criterion result has status failed", () => {
          expect(result!.criteria![1]!.status).toBe("failed");
        });
      }
    );

    Scenario(
      "A voluntary verdict with an undecided criterion continues the conversation",
      ({ Given, When, Then }) => {
        const { agent, calls } = makeJudge();
        let result: Awaited<ReturnType<typeof agent.call>>;

        Given("the judge chose make_verdict mid-conversation", () => {
          agent.invokeLLM = async (params) => {
            calls.push(params);
            return calls.length === 1
              ? toolCall("make_verdict", {})
              : finishWith(["passed", "inconclusive"]);
          };
        });

        When(
          "the verdict call marks one criterion passed and one inconclusive",
          async () => {
            result = await agent.call(createInput());
          }
        );

        Then("the conversation continues instead of ending", () => {
          expect(calls).toHaveLength(2);
          expect(result).toBeNull();
        });
      }
    );

    Scenario(
      "A voluntary verdict with a failed criterion ends the run",
      ({ Given, When, Then }) => {
        const { agent, calls } = makeJudge();
        let result: Awaited<ReturnType<typeof agent.call>>;

        Given("the judge chose make_verdict mid-conversation", () => {
          agent.invokeLLM = async (params) => {
            calls.push(params);
            return calls.length === 1
              ? toolCall("make_verdict", {})
              : finishWith(["failed", "inconclusive"]);
          };
        });

        When(
          "the verdict call marks one criterion failed and one inconclusive",
          async () => {
            result = await agent.call(createInput());
          }
        );

        Then("the run ends as a failure", () => {
          expect(result).not.toBeNull();
          expect(result!.success).toBe(false);
          expect(result!.unmetCriteria).toEqual(CRITERIA);
        });
      }
    );

    Scenario(
      "The verdict prompt defines passed against the criterion as a requirement",
      ({ Given, When, Then, And }) => {
        const criteria = ["The agent must not promise a refund"];
        const { agent, calls } = makeJudge(criteria);
        let prompt: string;

        Given("a judgment request with a criterion phrased as a fail condition", () => {
          agent.invokeLLM = async (params) => {
            calls.push(params);
            return finishWith(["passed"]);
          };
        });

        When("the verdict call runs", async () => {
          await agent.call(createInput({ judgmentRequest: { criteria } }));
          prompt = systemPrompt(calls[0]!);
        });

        Then(
          "the verdict prompt tells the judge to restate each criterion as a positive requirement",
          () => {
            expect(prompt).toContain("restate it as a positive requirement");
          }
        );

        And("it says a fail condition passes when the condition did not happen", () => {
          expect(prompt).toContain(
            "passes when X did not happen and fails when X happened"
          );
        });
      }
    );

    Scenario(
      "The run finished event carries the per-criterion result",
      ({ Given, When, Then, And }) => {
        const finished: ScenarioRunFinishedEvent[] = [];
        let execution: ScenarioExecution;

        Given("a run whose judge returned per-criterion results", () => {
          const judge = judgeAgent({
            criteria: CRITERIA,
            spanCollector: new JudgeSpanCollector(),
          });
          judge.invokeLLM = async (params) =>
            "finish_test" in (params.tools ?? {})
              ? finishWith(["passed", "inconclusive"])
              : toolCall("make_verdict", {});
          execution = new ScenarioExecution(
            {
              name: "per-criterion event",
              description: "A user asks for their password",
              agents: [new ScriptedAgent(), new ScriptedUser(), judge],
              maxTurns: 1,
            },
            [
              async (_state, executor) => {
                await executor.proceed();
              },
            ],
            "test-batch-id"
          );
          execution.events$.subscribe((event) => {
            if (event.type === ScenarioEventType.RUN_FINISHED) {
              finished.push(event as ScenarioRunFinishedEvent);
            }
          });
        });

        When("the run finished event is emitted", async () => {
          await execution.execute();
        });

        Then(
          "its results carry a criteria list with criterion, requirement, status and reasoning",
          () => {
            expect(finished).toHaveLength(1);
            expect(finished[0]!.results!.criteria).toEqual([
              {
                criterion: CRITERIA[0],
                requirement: "Requirement 1",
                status: "passed",
                reasoning: "Reasoning 1",
              },
              {
                criterion: CRITERIA[1],
                requirement: "Requirement 2",
                status: "inconclusive",
                reasoning: "Reasoning 2",
              },
            ]);
          }
        );

        And(
          "metCriteria, unmetCriteria and inconclusiveCriteria are still sent",
          () => {
            const results = finished[0]!.results!;
            expect(results.metCriteria).toEqual([CRITERIA[0]]);
            expect(results.unmetCriteria).toEqual([CRITERIA[1]]);
            expect(results.inconclusiveCriteria).toEqual([CRITERIA[1]]);
          }
        );
      }
    );

    Scenario(
      "A provider that refuses a forced tool choice gets the verdict with tool choice auto",
      ({ Given, When, Then, And }) => {
        const sent: InvokeLLMParams[] = [];
        let invoke: (params: InvokeLLMParams) => Promise<InvokeLLMResult>;
        const params = {
          model: "fake",
          messages: [{ role: "user", content: "Judge this." }],
          tools: {},
          toolChoice: { type: "tool", toolName: "finish_test" },
        } as unknown as InvokeLLMParams;

        Given("a model that rejects a forced tool choice", () => {
          invoke = createLLMInvoker(silentLogger, async (p) => {
            sent.push(p);
            if (p.toolChoice !== "auto") {
              throw new Error(
                'The model returned the following errors: tool_choice: type "tool" and "any" are not supported for this model.'
              );
            }
            return finishWith(["passed", "passed"]);
          });
        });

        When("the verdict call runs", async () => {
          await invoke(params);
        });

        Then(
          "the call is retried once with tool choice auto and an instruction to call the tool",
          () => {
            expect(sent).toHaveLength(2);
            expect(sent[1]!.toolChoice).toBe("auto");
            expect(sent[1]!.messages!.at(-1)).toEqual({
              role: "user",
              content:
                "Answer only by calling the finish_test tool, never with plain text.",
            });
          }
        );

        And("later calls of the same judge go straight to tool choice auto", async () => {
          await invoke(params);
          expect(sent).toHaveLength(3);
          expect(sent[2]!.toolChoice).toBe("auto");
        });
      }
    );

    Scenario(
      "A provider that refuses the temperature parameter gets the call without it",
      ({ Given, When, Then }) => {
        const sent: InvokeLLMParams[] = [];
        let invoke: (params: InvokeLLMParams) => Promise<InvokeLLMResult>;

        Given("a model that rejects the temperature parameter", () => {
          invoke = createLLMInvoker(silentLogger, async (p) => {
            sent.push(p);
            if (p.temperature !== undefined) {
              throw new Error(
                "The model returned the following errors: `temperature` is deprecated for this model."
              );
            }
            return finishWith(["passed", "passed"]);
          });
        });

        When("the verdict call runs", async () => {
          await invoke({
            model: "fake",
            messages: [{ role: "user", content: "Judge this." }],
            temperature: 0,
          } as unknown as InvokeLLMParams);
        });

        Then("the call is retried once without a temperature", () => {
          expect(sent).toHaveLength(2);
          expect(sent[0]!.temperature).toBe(0);
          expect("temperature" in sent[1]!).toBe(false);
        });
      }
    );

    Scenario(
      "Any other provider error is raised unchanged",
      ({ Given, When, Then }) => {
        const sent: InvokeLLMParams[] = [];
        let invoke: (params: InvokeLLMParams) => Promise<InvokeLLMResult>;
        let raised: unknown;
        const rejection = new Error("Invalid API key");

        Given("a model that rejects the call for another reason", () => {
          invoke = createLLMInvoker(silentLogger, async (p) => {
            sent.push(p);
            throw rejection;
          });
        });

        When("the verdict call runs", async () => {
          raised = await invoke({
            model: "fake",
            messages: [{ role: "user", content: "Judge this." }],
            temperature: 0,
            toolChoice: "required",
          } as unknown as InvokeLLMParams).catch((error: unknown) => error);
        });

        Then("the original error is raised without a retry", () => {
          expect(raised).toBe(rejection);
          expect(sent).toHaveLength(1);
        });
      }
    );
  },
  { includeTags: [["unit"]] }
);
