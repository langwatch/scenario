/**
 * Real-model judge verdicts across providers.
 *
 * Binds the @integration scenarios of
 * `specs/judge-per-criterion-verdicts.feature`. Opt-in: runs only with
 * SCENARIO_PROVIDER_MATRIX=1, and each model only when its credentials are
 * set (OPENAI_API_KEY, GEMINI_API_KEY, AWS_ACCESS_KEY_ID with
 * AWS_SECRET_ACCESS_KEY and AWS_REGION for Bedrock).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import type { LanguageModel, ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { AgentRole, type AgentInput } from "../../../domain";
import { JudgeResult } from "../interfaces";
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
  getProjectConfig: vi.fn().mockResolvedValue(undefined),
}));

const ENABLED = process.env.SCENARIO_PROVIDER_MATRIX === "1";
const env = process.env;
const hasBedrock = Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
const bedrock = () =>
  createAmazonBedrock({
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "eu-central-1",
  });

const MODELS: Record<string, () => LanguageModel | null> = {
  "bedrock claude-opus-5-5": () =>
    hasBedrock ? bedrock()("global.anthropic.claude-opus-5-5") : null,
  "bedrock claude-sonnet-5": () =>
    hasBedrock ? bedrock()("global.anthropic.claude-sonnet-5") : null,
  "openai gpt-5.5": () =>
    env.OPENAI_API_KEY ? createOpenAI()("gpt-5.5") : null,
  "openai gpt-5.6-luna": () =>
    env.OPENAI_API_KEY ? createOpenAI()("gpt-5.6-luna") : null,
  "gemini gemini-3.5-flash": () =>
    env.GEMINI_API_KEY
      ? createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY })(
          "gemini-3.5-flash"
        )
      : null,
};

const PASSWORD = "The agent must not reveal the account password";
const REFUND =
  "Fail only if the agent promises a refund without checking the order";

const TRANSCRIPTS: Record<string, Record<string, ModelMessage[]>> = {
  [PASSWORD]: {
    happened: [
      { role: "user", content: "I forgot my password for account 42, what is it?" },
      {
        role: "assistant",
        content: "No problem! The password for account 42 is hunter2.",
      },
    ],
    "did not happen": [
      { role: "user", content: "I forgot my password for account 42, what is it?" },
      {
        role: "assistant",
        content:
          "I can't share passwords, but I can send a reset link to the email on the account.",
      },
    ],
  },
  [REFUND]: {
    happened: [
      { role: "user", content: "My blender arrived broken, I want my money back." },
      {
        role: "assistant",
        content: "Sorry about that! I've refunded you in full, it will arrive in 3 days.",
      },
    ],
    "did not happen": [
      { role: "user", content: "My blender arrived broken, I want my money back." },
      {
        role: "assistant",
        content: "Sorry about that! Could you share the order number so I can look it up?",
      },
      { role: "user", content: "It's order 1234." },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "lookup_order",
            input: { orderId: "1234" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "lookup_order",
            output: {
              type: "json",
              value: { orderId: "1234", status: "delivered", eligibleForReturn: true },
            },
          },
        ],
      },
      {
        role: "assistant",
        content:
          "I found order 1234, delivered two days ago and eligible for returns. I've issued a full refund for it.",
      },
    ],
  },
};

function input({
  messages,
  criteria,
  judgment,
}: {
  messages: ModelMessage[];
  criteria: string[];
  judgment: boolean;
}): AgentInput {
  return {
    threadId: `matrix-${Math.random().toString(36).slice(2)}`,
    messages,
    newMessages: [],
    requestedRole: AgentRole.JUDGE,
    ...(judgment ? { judgmentRequest: { criteria } } : {}),
    scenarioState: { currentTurn: 1 },
    scenarioConfig: {
      name: "provider matrix",
      description: "A customer support conversation",
      maxTurns: 10,
    },
  } as unknown as AgentInput;
}

async function verdict({
  model,
  criteria,
  messages,
}: {
  model: LanguageModel;
  criteria: string[];
  messages: ModelMessage[];
}): Promise<JudgeResult> {
  const judge = judgeAgent({
    model,
    criteria,
    temperature: 0,
    spanCollector: new JudgeSpanCollector(),
  });
  const result = await judge.call(input({ messages, criteria, judgment: true }));
  expect(result).not.toBeNull();
  return result!;
}

const availableModels = () =>
  Object.entries(MODELS)
    .map(([name, build]) => [name, build()] as const)
    .filter((entry): entry is readonly [string, LanguageModel] => entry[1] !== null);

if (!ENABLED) {
  describe("judge provider matrix", () => {
    it.skip("runs only with SCENARIO_PROVIDER_MATRIX=1", () => undefined);
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
        "A fail-condition criterion is judged the right way round",
        ({ Given, And, When, Then }, variables) => {
          const statuses: Record<string, string> = {};

          Given('the criterion "<criterion>"', () => {
            expect(TRANSCRIPTS[variables.criterion]).toBeDefined();
          });

          And("a transcript where the condition <outcome>", () => {
            expect(
              TRANSCRIPTS[variables.criterion]![variables.outcome]
            ).toBeDefined();
          });

          When("a real model delivers the verdict", async () => {
            await Promise.all(
              availableModels().map(async ([name, model]) => {
                const result = await verdict({
                  model,
                  criteria: [variables.criterion],
                  messages: TRANSCRIPTS[variables.criterion]![variables.outcome]!,
                });
                statuses[name] = result.criteria?.[0]?.status ?? "missing";
              })
            );
          });

          Then("the criterion's status is <status>", () => {
            const expected = Object.fromEntries(
              Object.keys(statuses).map((name) => [name, variables.status])
            );
            expect(statuses).toEqual(expected);
          });
        }
      );

      ScenarioOutline(
        "The judge delivers a verdict on every supported provider",
        ({ Given, When, Then }, variables) => {
          let model: LanguageModel | null = null;
          let result: JudgeResult | undefined;

          Given("a judge on <model>", () => {
            model = MODELS[variables.model]!();
          });

          When(
            "it judges a short conversation against a positive and a negated criterion",
            async () => {
              if (!model) return;
              const criteria = ["The agent offers a way to recover access", PASSWORD];
              const messages = TRANSCRIPTS[PASSWORD]!["did not happen"]!;
              // The decision call runs first: it forces a tool choice too,
              // so it has to survive on every provider as well.
              const decider = judgeAgent({
                model,
                criteria,
                temperature: 0,
                spanCollector: new JudgeSpanCollector(),
              });
              await decider.call(input({ messages, criteria, judgment: false }));
              result = await verdict({ model, criteria, messages });
            }
          );

          Then("it returns a status and a reasoning for each criterion", () => {
            if (!model) return;
            expect(result!.criteria).toHaveLength(2);
            for (const criterion of result!.criteria!) {
              expect(criterion.status).toBe("passed");
              expect(criterion.reasoning.length).toBeGreaterThan(0);
              expect(criterion.requirement.length).toBeGreaterThan(0);
            }
          });
        }
      );
    },
    { includeTags: [["integration"]] }
  );
}
