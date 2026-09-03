// Ref: specs/scenario-evaluators.feature
import type { ModelMessage } from "ai";
import { describe, it, expect, vi } from "vitest";
import type { ScenarioResult } from "../../domain";
import type { EvaluateApiResponse, EvaluatorSpec } from "../evaluations-api";
import { evaluator, field, trace } from "../mappings";
import {
  applyEvaluationsToResult,
  runScenarioEvaluators,
  type RunEvaluatorsDeps,
} from "../run-evaluators";

const sqlEquivalence: EvaluatorSpec = {
  evaluatorId: "ragas/sql_query_equivalence",
  name: "SQL Query Equivalence",
  inputs: [
    { id: "output", required: true },
    { id: "expected_output", required: true },
    { id: "expected_contexts", required: true },
  ],
  producesPassed: true,
};

const scoreJudge: EvaluatorSpec = {
  evaluatorId: "eval_123",
  name: "Answer quality",
  inputs: [
    { id: "input", required: false },
    { id: "output", required: false },
  ],
  producesPassed: false,
};

const messages: ModelMessage[] = [
  { role: "user", content: "Chargebacks per quarter for ACME Travel?" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "run_sql",
        input: { sql: "SELECT quarter, count(*) FROM chargebacks GROUP BY 1" },
      },
    ],
  },
  { role: "assistant", content: "Here are the totals per quarter." },
];
(messages[2] as ModelMessage & { traceId?: string }).traceId = "trace-last";
(messages[1] as ModelMessage & { traceId?: string }).traceId = "trace-last";

function depsWith({
  specs,
  response,
  fetchRemoteTraces,
}: {
  specs: Record<string, EvaluatorSpec>;
  response?: EvaluateApiResponse | Error;
  fetchRemoteTraces?: () => Promise<void>;
}): RunEvaluatorsDeps & { evaluate: ReturnType<typeof vi.fn> } {
  const evaluate = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response ?? { status: "processed" as const, passed: true, details: "ok" };
  });
  return {
    getEvaluatorSpec: async (ref) => specs[ref],
    evaluate,
    getSpans: () => [],
    fetchRemoteTraces,
  };
}

const context = {
  messages,
  description: "A fraud analyst asks for chargebacks per quarter.",
  criteria: [],
  fields: { golden_sql: "SELECT quarter, count(*) FROM chargebacks GROUP BY 1", table_schema: "CREATE TABLE chargebacks (...)" },
};

const judgeSuccess: ScenarioResult = {
  runId: "run_1",
  success: true,
  messages,
  reasoning: "All criteria passed",
  metCriteria: ["Reports totals"],
  unmetCriteria: [],
};

describe("running scenario evaluators", () => {
  describe("given a required evaluator mapped to the run_sql tool call and the fields", () => {
    const attachment = evaluator("ragas/sql_query_equivalence", {
      required: true,
      mappings: {
        output: trace.toolCall("run_sql").input,
        expected_output: field("golden_sql"),
        expected_contexts: field("table_schema"),
      },
    });

    // Scenario: The evaluate call carries the resolved inputs and the trace id of the last turn
    describe("when the evaluators run", () => {
      it("calls the evaluate endpoint with the resolved data and the trace id of the last turn", async () => {
        const deps = depsWith({ specs: { "ragas/sql_query_equivalence": sqlEquivalence } });
        const [result] = await runScenarioEvaluators({
          evaluators: [attachment],
          context,
          traceId: "trace-last",
          deps,
        });

        expect(deps.evaluate).toHaveBeenCalledWith({
          evaluatorRef: "ragas/sql_query_equivalence",
          data: {
            output: { sql: "SELECT quarter, count(*) FROM chargebacks GROUP BY 1" },
            expected_output: "SELECT quarter, count(*) FROM chargebacks GROUP BY 1",
            expected_contexts: ["CREATE TABLE chargebacks (...)"],
          },
          settings: undefined,
          traceId: "trace-last",
        });
        expect(result).toMatchObject({
          evaluatorId: "ragas/sql_query_equivalence",
          name: "SQL Query Equivalence",
          status: "passed",
          required: true,
          passed: true,
          details: "ok",
        });
        expect(result.inputs?.expected_output).toBe(
          "SELECT quarter, count(*) FROM chargebacks GROUP BY 1"
        );
        expect(result.inputs?.output).toContain("SELECT quarter");
      });

      it("does not fetch the remote trace when the messages carry the tool call", async () => {
        const fetchRemoteTraces = vi.fn(async () => {});
        const deps = depsWith({
          specs: { "ragas/sql_query_equivalence": sqlEquivalence },
          fetchRemoteTraces,
        });
        await runScenarioEvaluators({ evaluators: [attachment], context, traceId: "trace-last", deps });
        expect(fetchRemoteTraces).not.toHaveBeenCalled();
      });
    });

    // Scenario: A required evaluator that fails fails the run
    describe("when the evaluate response is passed false", () => {
      it("fails the run and names the evaluator in the reasoning", async () => {
        const deps = depsWith({
          specs: { "ragas/sql_query_equivalence": sqlEquivalence },
          response: { status: "processed", passed: false, details: "Different grouping" },
        });
        const evaluations = await runScenarioEvaluators({
          evaluators: [attachment],
          context,
          traceId: "trace-last",
          deps,
        });
        const result = applyEvaluationsToResult({ result: judgeSuccess, evaluations });

        expect(evaluations[0].status).toBe("failed");
        expect(result.success).toBe(false);
        expect(result.reasoning).toBe(
          "All criteria passed\nEvaluator SQL Query Equivalence failed: Different grouping"
        );
        expect(result.evaluations).toEqual(evaluations);
        expect(result.metCriteria).toEqual(["Reports totals"]);
      });
    });

    // Scenario: A blank field skips the evaluator with a reason
    describe("when the scenario does not set golden_sql", () => {
      it("skips the evaluator without calling the endpoint", async () => {
        const deps = depsWith({ specs: { "ragas/sql_query_equivalence": sqlEquivalence } });
        const [result] = await runScenarioEvaluators({
          evaluators: [attachment],
          context: { ...context, fields: { table_schema: "CREATE TABLE chargebacks (...)" } },
          traceId: "trace-last",
          deps,
        });
        expect(result).toMatchObject({
          status: "skipped",
          required: true,
          details: "no golden_sql on this scenario",
        });
        expect(deps.evaluate).not.toHaveBeenCalled();
      });
    });

    // Scenario: A missing tool call fails the evaluator with a reason
    describe("when the messages and the trace carry no run_sql call", () => {
      it("fails the evaluator with the reason after one remote fetch", async () => {
        const fetchRemoteTraces = vi.fn(async () => {});
        const deps = depsWith({
          specs: { "ragas/sql_query_equivalence": sqlEquivalence },
          fetchRemoteTraces,
        });
        const [result] = await runScenarioEvaluators({
          evaluators: [attachment],
          context: { ...context, messages: [{ role: "assistant", content: "Done." }] },
          traceId: "trace-last",
          deps,
        });
        expect(result).toMatchObject({
          status: "failed",
          required: true,
          passed: false,
          details: "no run_sql call in the trace",
        });
        expect(fetchRemoteTraces).toHaveBeenCalledTimes(1);
        expect(deps.evaluate).not.toHaveBeenCalled();
      });

      it("fails the run when the evaluator is required", async () => {
        const deps = depsWith({ specs: { "ragas/sql_query_equivalence": sqlEquivalence } });
        const evaluations = await runScenarioEvaluators({
          evaluators: [attachment],
          context: { ...context, messages: [{ role: "assistant", content: "Done." }] },
          traceId: undefined,
          deps,
        });
        const result = applyEvaluationsToResult({ result: judgeSuccess, evaluations });
        expect(result.success).toBe(false);
        expect(result.reasoning).toContain("no run_sql call in the trace");
      });
    });

    // Scenario: An evaluate endpoint failure is reported as an error
    describe("when the evaluate endpoint answers with an error", () => {
      it("reports an error result and leaves the run as the judge decided", async () => {
        const deps = depsWith({
          specs: { "ragas/sql_query_equivalence": sqlEquivalence },
          response: new Error("Evaluation API answered 500: boom"),
        });
        const evaluations = await runScenarioEvaluators({
          evaluators: [attachment],
          context,
          traceId: "trace-last",
          deps,
        });
        const result = applyEvaluationsToResult({ result: judgeSuccess, evaluations });
        expect(evaluations[0]).toMatchObject({
          status: "error",
          details: "Evaluation API answered 500: boom",
        });
        expect(result.success).toBe(true);
        expect(result.reasoning).toBe("All criteria passed");
      });
    });
  });

  describe("given a saved score evaluator with inferred mappings", () => {
    // Scenario: A score never gates the run
    it("reports the score and keeps the run successful", async () => {
      const deps = depsWith({
        specs: { "evaluators/answer-quality": scoreJudge },
        response: { status: "processed", score: 0.4, details: "Vague answer" },
      });
      const evaluations = await runScenarioEvaluators({
        evaluators: [evaluator("evaluators/answer-quality", { required: true })],
        context,
        traceId: "trace-last",
        deps,
      });
      const result = applyEvaluationsToResult({ result: judgeSuccess, evaluations });

      expect(deps.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          evaluatorRef: "evaluators/answer-quality",
          data: {
            input: "Chargebacks per quarter for ACME Travel?",
            output: "Here are the totals per quarter.",
          },
        })
      );
      expect(evaluations[0]).toMatchObject({
        evaluatorId: "eval_123",
        name: "Answer quality",
        status: "scored",
        score: 0.4,
        required: true,
      });
      expect(result.success).toBe(true);
    });

    it("defaults required to false for a score-only evaluator", async () => {
      const deps = depsWith({
        specs: { "evaluators/answer-quality": scoreJudge },
        response: { status: "processed", score: 0.9 },
      });
      const [result] = await runScenarioEvaluators({
        evaluators: [evaluator("evaluators/answer-quality")],
        context,
        traceId: undefined,
        deps,
      });
      expect(result.required).toBe(false);
    });
  });

  describe("given an evaluator LangWatch does not know", () => {
    it("reports an error result", async () => {
      const deps = depsWith({ specs: {} });
      const [result] = await runScenarioEvaluators({
        evaluators: [evaluator("langevals/nope")],
        context,
        traceId: undefined,
        deps,
      });
      expect(result).toMatchObject({
        evaluatorId: "langevals/nope",
        status: "error",
        details: "Evaluator langevals/nope was not found in LangWatch",
      });
    });
  });

  describe("given a required input that no mapping or inference covers", () => {
    it("reports an error result naming the input", async () => {
      const deps = depsWith({
        specs: {
          "ragas/sql_query_equivalence": { ...sqlEquivalence, inputs: [{ id: "expected_output", required: true }] },
        },
      });
      const [result] = await runScenarioEvaluators({
        evaluators: [evaluator("ragas/sql_query_equivalence")],
        context: { ...context, fields: {} },
        traceId: undefined,
        deps,
      });
      expect(result.status).toBe("error");
      expect(result.details).toContain("expected_output");
    });
  });
});
