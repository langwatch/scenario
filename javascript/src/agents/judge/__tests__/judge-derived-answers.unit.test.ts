/**
 * Binds the @unit scenarios of `specs/judge-derived-answers.feature`: the
 * verdict rules that make the judge recompute numbers and accept correctly
 * derived answers, and the reasoning-before-status order of finish_test.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";
import { z } from "zod/v4";

import { AgentRole, type AgentInput } from "../../../domain";
import type { InvokeLLMParams, InvokeLLMResult } from "../../types";
import { buildFinishTestTool } from "../criterion-verdicts";
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
  "judge-derived-answers.feature",
);

vi.mock("../../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue({
    defaultModel: { model: "openai/gpt-5-mini" },
  }),
}));

// JSON Schema output is untyped; the assertions read nested fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

const CRITERION = "The answer is 2009";

async function verdictSystemPrompt(): Promise<string> {
  const calls: InvokeLLMParams[] = [];
  const judge = judgeAgent({
    criteria: [CRITERION],
    spanCollector: new JudgeSpanCollector(),
  });
  judge.invokeLLM = async (params) => {
    calls.push(params);
    return {
      text: "",
      content: [],
      toolCalls: [
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "finish_test",
          input: {
            criteria: {},
            reasoning: "done",
          },
        },
      ],
      toolResults: [],
    } as unknown as InvokeLLMResult;
  };
  await judge.call({
    threadId: "derived-unit",
    messages: [{ role: "user", content: "Which year?" }],
    newMessages: [],
    requestedRole: AgentRole.JUDGE,
    judgmentRequest: { criteria: [CRITERION] },
    scenarioState: { currentTurn: 1 },
    scenarioConfig: { name: "derived", description: "A question", maxTurns: 5 },
  } as unknown as AgentInput);
  const first = calls[0]!.messages![0]!;
  return typeof first.content === "string" ? first.content : "";
}

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Background, Scenario }) => {
    Background(({ Given }) => {
      Given("a JudgeAgent with success criteria", () => undefined);
    });

    Scenario(
      "The verdict prompt asks the judge to recompute numbers before grading",
      ({ When, Then, And }) => {
        let prompt = "";

        When("the verdict call is built", async () => {
          prompt = await verdictSystemPrompt();
        });

        Then(
          "its rules tell the judge to recompute any number, date, count or duration from the evidence step by step",
          () => {
            expect(prompt).toContain(
              "Before grading a number, date, count or duration, recompute it from the evidence step by step",
            );
          },
        );

        And(
          "its rules say an equivalent or correctly derived answer satisfies a criterion",
          () => {
            expect(prompt).toContain(
              "Be strict about evidence, not wording: an answer that is equivalent",
            );
            expect(prompt).toContain(
              "Recomputing a number or following a derivation that a criterion depends on is not an extra judgment call.",
            );
          },
        );

        And("its rules still require clear evidence for a pass", () => {
          expect(prompt).toContain(
            "Be strict: a criterion passes only when the conversation or the collected evidence clearly shows it was met.",
          );
        });
      },
    );

    Scenario(
      "Each criterion's reasoning comes before its status",
      ({ When, Then, And }) => {
        let criterionSchema: JsonObject = {};

        When("the finish_test tool is built", () => {
          const tool = buildFinishTestTool([CRITERION]);
          const schema = z.toJSONSchema(
            tool.inputSchema as z.ZodType,
          ) as JsonObject;
          const criteria = schema.properties.criteria.properties as JsonObject;
          criterionSchema = Object.values(criteria)[0] as JsonObject;
        });

        Then(
          "each criterion's fields are declared in the order requirement, reasoning, status",
          () => {
            expect(Object.keys(criterionSchema.properties)).toEqual([
              "requirement",
              "reasoning",
              "status",
            ]);
          },
        );

        And(
          "the reasoning description asks for the recomputation before the status",
          () => {
            const description: string =
              criterionSchema.properties.reasoning.description;
            expect(description).toContain("Written before the status.");
            expect(description).toContain(
              "recompute it here from the evidence step by step",
            );
          },
        );
      },
    );
  },
  { includeTags: [["unit"]] },
);
