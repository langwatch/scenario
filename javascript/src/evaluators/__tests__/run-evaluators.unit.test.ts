// Ref: specs/scenario-evaluators.feature
import { describe, it, expect, vi } from "vitest";
import type { ScenarioResult } from "../../domain";
import {
  messagesWithToolCall,
  span,
  stateWith,
  SQL_INPUT,
  type StampedMessage,
} from "../../execution/__tests__/state-fixture";
import type { ScenarioExecutionState } from "../../execution/scenario-execution-state";
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

const FIELDS = {
  golden_sql: "SELECT quarter, count(*) FROM chargebacks GROUP BY 1",
  table_schema: "CREATE TABLE chargebacks (...)",
};

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
    fetchRemoteTraces,
  };
}

function fullState(overrides: Parameters<typeof stateWith>[0] = {}): ScenarioExecutionState {
  return stateWith({ messages: messagesWithToolCall, fields: FIELDS, ...overrides });
}

const judgeSuccess: ScenarioResult = {
  runId: "run_1",
  success: true,
  messages: [],
  reasoning: "All criteria passed",
  metCriteria: ["Reports totals"],
  unmetCriteria: [],
};

describe("running scenario evaluators", () => {
  describe("given a required evaluator mapped to the run_sql tool call and the fields", () => {
    const attachment = evaluator("ragas/sql_query_equivalence", {
      required: true,
      mappings: {
        output: (state) => state.toolCalls("run_sql").last?.input,
        expected_output: field("golden_sql"),
        expected_contexts: (state) => state.field("table_schema"),
      },
    });

    // Scenario: The evaluate call carries the resolved inputs and the trace id of the last turn
    describe("when the evaluators run", () => {
      it("calls the evaluate endpoint with the resolved data and the trace id of the last turn", async () => {
        const deps = depsWith({ specs: { "ragas/sql_query_equivalence": sqlEquivalence } });
        const [result] = await runScenarioEvaluators({
          evaluators: [attachment],
          state: fullState(),
          traceId: "trace-1",
          deps,
        });

        expect(deps.evaluate).toHaveBeenCalledWith({
          evaluatorRef: "ragas/sql_query_equivalence",
          data: {
            output: SQL_INPUT,
            expected_output: FIELDS.golden_sql,
            expected_contexts: [FIELDS.table_schema],
          },
          settings: undefined,
          traceId: "trace-1",
        });
        expect(result).toMatchObject({
          evaluatorId: "ragas/sql_query_equivalence",
          name: "SQL Query Equivalence",
          status: "passed",
          required: true,
          passed: true,
          details: "ok",
        });
        expect(result.inputs?.expected_output).toBe(FIELDS.golden_sql);
        expect(result.inputs?.output).toBe(JSON.stringify(SQL_INPUT));
      });

      // Scenario: A tool call input resolves from the message tool calls
      it("does not fetch the remote trace when the messages carry the tool call", async () => {
        const fetchRemoteTraces = vi.fn(async () => {});
        const deps = depsWith({
          specs: { "ragas/sql_query_equivalence": sqlEquivalence },
          fetchRemoteTraces,
        });
        await runScenarioEvaluators({ evaluators: [attachment], state: fullState(), traceId: "trace-1", deps });
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
          state: fullState(),
          traceId: "trace-1",
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

    // Scenario: A blank field skips the evaluator with the field name
    describe("when the scenario does not set golden_sql", () => {
      it("skips the evaluator without calling the endpoint", async () => {
        const deps = depsWith({ specs: { "ragas/sql_query_equivalence": sqlEquivalence } });
        const [result] = await runScenarioEvaluators({
          evaluators: [attachment],
          state: fullState({ fields: { table_schema: FIELDS.table_schema } }),
          traceId: "trace-1",
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

    // Scenario: A missing tool call skips the evaluator with the tool name
    // Scenario: A mapping that read the trace and found nothing fetches the remote traces once
    describe("when the messages and the trace carry no run_sql call", () => {
      const noCall: StampedMessage[] = [{ role: "assistant", content: "Done.", traceId: "trace-1" }];

      it("fetches the remote traces once, calls the mappings again and skips with the reason", async () => {
        const state = fullState({ messages: noCall });
        const calls: string[] = [];
        const fetchRemoteTraces = vi.fn(async () => {
          calls.push("fetch");
        });
        const deps = depsWith({
          specs: { "ragas/sql_query_equivalence": sqlEquivalence },
          fetchRemoteTraces,
        });
        const [result] = await runScenarioEvaluators({
          evaluators: [
            evaluator("ragas/sql_query_equivalence", {
              mappings: {
                output: (s) => {
                  calls.push("output");
                  return s.toolCalls("run_sql").last?.input;
                },
                expected_output: field("golden_sql"),
                expected_contexts: trace.toolCalls("run_sql").last.output,
              },
            }),
          ],
          state,
          traceId: "trace-1",
          deps,
        });
        expect(result).toMatchObject({
          status: "skipped",
          required: true,
          details: "no run_sql call in the trace",
        });
        expect(fetchRemoteTraces).toHaveBeenCalledTimes(1);
        expect(calls).toEqual(["output", "fetch", "output"]);
        expect(deps.evaluate).not.toHaveBeenCalled();
      });

      it("finds the call the fetch brought in", async () => {
        let spans: ReturnType<typeof span>[] = [];
        const state = fullState({ messages: noCall });
        state.setSpanProvider(() => spans);
        const deps = depsWith({
          specs: { "ragas/sql_query_equivalence": sqlEquivalence },
          fetchRemoteTraces: async () => {
            spans = [
              span({
                name: "run_sql",
                attributes: { "langwatch.span.type": "tool", "langwatch.input": '{"sql":"SELECT 1"}' },
              }),
            ];
          },
        });
        const [result] = await runScenarioEvaluators({ evaluators: [attachment], state, traceId: "trace-1", deps });
        expect(result.status).toBe("passed");
        expect(deps.evaluate).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ output: '{"sql":"SELECT 1"}' }) })
        );
      });

      it("fetches once for two evaluators that read the trace", async () => {
        const fetchRemoteTraces = vi.fn(async () => {});
        const deps = depsWith({
          specs: { "ragas/sql_query_equivalence": sqlEquivalence },
          fetchRemoteTraces,
        });
        await runScenarioEvaluators({
          evaluators: [attachment, attachment],
          state: fullState({ messages: noCall }),
          traceId: "trace-1",
          deps,
        });
        expect(fetchRemoteTraces).toHaveBeenCalledTimes(1);
      });

      it("does not fetch when the messages carry no trace id", async () => {
        const fetchRemoteTraces = vi.fn(async () => {});
        const deps = depsWith({
          specs: { "ragas/sql_query_equivalence": sqlEquivalence },
          fetchRemoteTraces,
        });
        await runScenarioEvaluators({
          evaluators: [attachment],
          state: fullState({ messages: [{ role: "assistant", content: "Done." }] }),
          traceId: undefined,
          deps,
        });
        expect(fetchRemoteTraces).not.toHaveBeenCalled();
      });

      it("keeps the run as the judge decided", async () => {
        const deps = depsWith({ specs: { "ragas/sql_query_equivalence": sqlEquivalence } });
        const evaluations = await runScenarioEvaluators({
          evaluators: [attachment],
          state: fullState({ messages: noCall }),
          traceId: undefined,
          deps,
        });
        const result = applyEvaluationsToResult({ result: judgeSuccess, evaluations });
        expect(result.success).toBe(true);
      });
    });

    // Scenario: A mapping that returns nothing skips the evaluator
    // Scenario: A mapping that did not read the trace never fetches the remote traces
    describe("when a mapping returns nothing without reading the trace", () => {
      it("skips with the generic reason and never fetches", async () => {
        const fetchRemoteTraces = vi.fn(async () => {});
        const deps = depsWith({
          specs: { "ragas/sql_query_equivalence": sqlEquivalence },
          fetchRemoteTraces,
        });
        const [result] = await runScenarioEvaluators({
          evaluators: [
            evaluator("ragas/sql_query_equivalence", {
              mappings: { ...attachment.mappings, output: () => undefined },
            }),
          ],
          state: fullState(),
          traceId: "trace-1",
          deps,
        });
        expect(result).toMatchObject({ status: "skipped", details: "the mapping returned nothing" });
        expect(fetchRemoteTraces).not.toHaveBeenCalled();
        expect(deps.evaluate).not.toHaveBeenCalled();
      });
    });

    // Scenario: A mapping that raises errors the evaluator
    describe("when a mapping throws", () => {
      it("reports an error with the message and does not call the endpoint", async () => {
        const deps = depsWith({ specs: { "ragas/sql_query_equivalence": sqlEquivalence } });
        const [result] = await runScenarioEvaluators({
          evaluators: [
            evaluator("ragas/sql_query_equivalence", {
              mappings: {
                ...attachment.mappings,
                output: () => {
                  throw new Error("no SQL found");
                },
              },
            }),
          ],
          state: fullState(),
          traceId: "trace-1",
          deps,
        });
        expect(result.status).toBe("error");
        expect(result.details).toBe("Mapping of output failed: no SQL found");
        expect(deps.evaluate).not.toHaveBeenCalled();
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
          state: fullState(),
          traceId: "trace-1",
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
        state: fullState(),
        traceId: "trace-1",
        deps,
      });
      const result = applyEvaluationsToResult({ result: judgeSuccess, evaluations });

      expect(deps.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          evaluatorRef: "evaluators/answer-quality",
          data: {
            input: "How many chargebacks last quarter?",
            output: "There were 12 chargebacks.",
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
        state: fullState(),
        traceId: undefined,
        deps,
      });
      expect(result.required).toBe(false);
    });

    it("leaves an inferred optional input that resolves to nothing out of the call", async () => {
      const deps = depsWith({ specs: { "evaluators/answer-quality": scoreJudge } });
      await runScenarioEvaluators({
        evaluators: [evaluator("evaluators/answer-quality")],
        state: fullState({ messages: [{ role: "user", content: "Hi", traceId: "trace-1" }] }),
        traceId: undefined,
        deps,
      });
      expect(deps.evaluate).toHaveBeenCalledWith(expect.objectContaining({ data: { input: "Hi" } }));
    });
  });

  describe("given a literal mapping", () => {
    it("sends the literal as the input", async () => {
      const deps = depsWith({ specs: { "evaluators/answer-quality": scoreJudge } });
      await runScenarioEvaluators({
        evaluators: [evaluator("evaluators/answer-quality", { mappings: { output: "fixed answer" } })],
        state: fullState(),
        traceId: undefined,
        deps,
      });
      expect(deps.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ output: "fixed answer" }) })
      );
    });
  });

  describe("given an evaluator LangWatch does not know", () => {
    it("reports an error result", async () => {
      const deps = depsWith({ specs: {} });
      const [result] = await runScenarioEvaluators({
        evaluators: [evaluator("langevals/nope")],
        state: fullState(),
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
        state: fullState({ fields: {} }),
        traceId: undefined,
        deps,
      });
      expect(result.status).toBe("error");
      expect(result.details).toContain("expected_output");
    });
  });
});
