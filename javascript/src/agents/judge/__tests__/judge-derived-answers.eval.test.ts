/**
 * Real-model eval of the judge on numbers and derived answers.
 *
 * Binds the @integration scenarios of `specs/judge-derived-answers.feature`.
 * Opt-in: SCENARIO_JUDGE_EVAL=1 with OPENAI_API_KEY, or with
 * AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY (deployment named after the
 * model). Prints the status counts per case for before and after comparisons.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createOpenAI } from "@ai-sdk/openai";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { LanguageModel, ModelMessage } from "ai";
import { attributes } from "langwatch/observability";
import { describe, expect, it, vi } from "vitest";

import { AgentRole, type AgentInput } from "../../../domain";
import { judgeAgent as currentJudgeAgent } from "../judge-agent";
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
  "judge-derived-answers.feature",
);

vi.mock("../../../config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue(undefined),
}));

const env = process.env;
const AZURE = Boolean(env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_API_KEY);
const ENABLED =
  env.SCENARIO_JUDGE_EVAL === "1" && (AZURE || Boolean(env.OPENAI_API_KEY));
const MODEL = env.SCENARIO_JUDGE_EVAL_MODEL ?? "gpt-5-mini";

// SCENARIO_JUDGE_EVAL_SDK points at another build's dist/index.js, so the
// same cases can run against a released judge for a baseline.
const judgeAgent: typeof currentJudgeAgent = env.SCENARIO_JUDGE_EVAL_SDK
  ? (await import(env.SCENARIO_JUDGE_EVAL_SDK)).judgeAgent
  : currentJudgeAgent;

function evalModel(): LanguageModel {
  if (!AZURE) return createOpenAI()(MODEL);
  return createOpenAI({
    baseURL: `${env.AZURE_OPENAI_ENDPOINT!.replace(/\/$/, "")}/openai/v1`,
    apiKey: env.AZURE_OPENAI_API_KEY,
    headers: { "api-key": env.AZURE_OPENAI_API_KEY! },
  })(MODEL);
}

const QUESTIONS: Record<string, string> = {
  merger:
    "According to the article: 'Founded in 1994, the company merged with its rival in 2009.' How many years passed between the founding and the merger?",
  festival:
    "According to the article: 'The Cliffside Festival was first held in 1988. Its attendance record fell on its 21st anniversary.' In which year did the attendance record fall?",
  ceasefire:
    "According to the article: 'The ceasefire began on 3 March and ended on 28 March.' How many days did the ceasefire last?",
  "merger in trace":
    "How many years passed between the founding of Norvik Shipping and its merger with its rival?",
  "festival in trace":
    "In which year did the Cliffside Festival's attendance record fall?",
};
QUESTIONS["merger in long trace"] = QUESTIONS["merger in trace"]!;
QUESTIONS["festival in long trace"] = QUESTIONS["festival in trace"]!;

/** Retrieved articles, recorded as a retrieval span the judge reads. */
const DOCUMENTS: Record<string, string> = {
  "merger in trace":
    "Norvik Shipping was founded in 1994 in Bergen by two ferry captains. After a decade of expansion along the coast it bought a rival fleet in 2005. In 2009 Norvik merged with its long-time rival Fjordline, forming the largest regional operator.",
  "festival in trace":
    "The Cliffside Festival was first held in 1988 on the north coast. It has run every summer since. Its attendance record fell on its 21st anniversary, when 41,000 visitors came.",
};

/** About 40k characters of unrelated articles with the answer at 30k. */
function longDocuments(article: string): string {
  const filler =
    "The regional council met on Tuesday to discuss road maintenance budgets and the new bus timetable. ";
  const before = filler.repeat(Math.ceil(30_000 / filler.length));
  const after = filler.repeat(Math.ceil(10_000 / filler.length));
  return before + article + " " + after;
}
DOCUMENTS["merger in long trace"] = longDocuments(
  DOCUMENTS["merger in trace"]!,
);
DOCUMENTS["festival in long trace"] = longDocuments(
  DOCUMENTS["festival in trace"]!,
);

function retrievalSpan(threadId: string, topic: string): ReadableSpan {
  return createSpan({
    spanId: "a1b2c3d4e5f60718",
    name: "retrieve_documents",
    startTime: [1_700_000_000, 0],
    endTime: [1_700_000_000, 300_000_000],
    attributes: {
      [attributes.ATTR_LANGWATCH_THREAD_ID]: threadId,
      "retrieval.documents": JSON.stringify([
        { id: "doc-1", content: DOCUMENTS[topic] },
      ]),
    },
  });
}

async function judgeOnce({
  topic,
  criterion,
  answer,
}: {
  topic: string;
  criterion: string;
  answer: string;
}): Promise<string> {
  const messages: ModelMessage[] = [
    { role: "user", content: QUESTIONS[topic]! },
    { role: "assistant", content: answer },
  ];
  const threadId = `derived-${Math.random().toString(36).slice(2)}`;
  const spanCollector = new JudgeSpanCollector();
  if (DOCUMENTS[topic]) spanCollector.onEnd(retrievalSpan(threadId, topic));
  const judge = judgeAgent({
    model: evalModel(),
    criteria: [criterion],
    spanCollector,
  });
  if (env.SCENARIO_JUDGE_EVAL_DEBUG === "1") {
    const invoke = judge.invokeLLM;
    judge.invokeLLM = async (params) => {
      const completion = await invoke(params);
      for (const step of completion.steps ?? []) {
        for (const call of step.toolCalls ?? []) {
          // eslint-disable-next-line no-console
          console.log(
            `[judge-eval:${topic}] ${call.toolName} ${JSON.stringify(call.input).slice(0, 600)}`,
          );
        }
      }
      return completion;
    };
  }
  const result = await judge.call({
    threadId,
    messages,
    newMessages: [],
    requestedRole: AgentRole.JUDGE,
    judgmentRequest: { criteria: [criterion] },
    scenarioState: { currentTurn: 1 },
    scenarioConfig: {
      name: "derived answers",
      description: "A user asks a question about a news article",
      maxTurns: 10,
    },
  } as unknown as AgentInput);
  if (!result) return "missing";
  // Builds before per-criterion verdicts only report met and unmet lists.
  if (!result.criteria) {
    return result.metCriteria.includes(criterion) ? "passed" : "failed";
  }
  return result.criteria[0]?.status ?? "missing";
}

if (!ENABLED) {
  describe("judge derived answers eval", () => {
    it.skip("runs only with SCENARIO_JUDGE_EVAL=1 and model credentials", () =>
      undefined);
  });
} else {
  const feature = await loadFeature(FEATURE_PATH);

  describeFeature(
    feature,
    ({ Background, ScenarioOutline }) => {
      Background(({ Given }) => {
        Given("a JudgeAgent with success criteria", () => undefined);
      });

      ScenarioOutline(
        "A real model grades derived answers",
        ({ Given, And, When, Then }, variables) => {
          let statuses: string[] = [];

          Given("the user asked a question about the <topic> article", () => {
            expect(QUESTIONS[variables.topic]).toBeDefined();
          });
          And('the criterion "<criterion>"', () => undefined);
          And('an agent that answers "<answer>"', () => undefined);

          When("gpt-5-mini delivers the verdict <runs> times", async () => {
            statuses = await Promise.all(
              Array.from({ length: Number(variables.runs) }, () =>
                judgeOnce({
                  topic: variables.topic,
                  criterion: variables.criterion,
                  answer: variables.answer,
                }),
              ),
            );
          });

          Then(
            "the criterion's status is <status> in at least <minimum> of the runs",
            () => {
              const hits = statuses.filter(
                (s) => s === variables.status,
              ).length;
              // eslint-disable-next-line no-console
              console.log(
                `[judge-eval] ${MODEL} "${variables.criterion}" vs "${variables.answer.slice(0, 60)}": ${hits}/${statuses.length} ${variables.status} (${statuses.join(",")})`,
              );
              expect(hits).toBeGreaterThanOrEqual(Number(variables.minimum));
            },
          );
        },
      );
    },
    { includeTags: [["integration"]] },
  );
}
