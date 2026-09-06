// Ref: specs/scenario-evaluators.feature
import { describe, expect, it, vi } from "vitest";
import { EvaluationsApiClient } from "../evaluations-api";

const auth = { endpoint: "http://localhost:5560", apiKey: "sk-test", projectId: undefined };

function fetchAnswering(bodies: Record<string, unknown>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const path = new URL(url).pathname;
    const body = bodies[path];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("the evaluations API client", () => {
  describe("given a saved evaluator whose record declares its fields", () => {
    // Scenario: A saved evaluator declares its own inputs
    it("lists the required and optional inputs and whether it answers passed", async () => {
      const { fetchFn } = fetchAnswering({
        "/api/evaluators/answer-check": {
          id: "eval_1",
          name: "Answer check",
          config: { evaluatorType: "custom/code" },
          fields: [
            { identifier: "output", type: "str" },
            { identifier: "contexts", type: "list", optional: true },
          ],
          outputFields: [{ identifier: "passed", type: "bool" }],
        },
      });
      const client = new EvaluationsApiClient(auth, { fetchFn });
      expect(await client.getEvaluatorSpec("evaluators/answer-check")).toEqual({
        evaluatorId: "eval_1",
        name: "Answer check",
        inputs: [
          { id: "output", required: true },
          { id: "contexts", required: false },
        ],
        producesPassed: true,
      });
    });

    it("marks a score-only saved evaluator as not answering passed", async () => {
      const { fetchFn } = fetchAnswering({
        "/api/evaluators/quality": {
          id: "eval_2",
          name: "Quality",
          fields: [{ identifier: "output", type: "str" }],
          outputFields: [{ identifier: "score", type: "float" }],
        },
      });
      const client = new EvaluationsApiClient(auth, { fetchFn });
      expect((await client.getEvaluatorSpec("evaluators/quality"))?.producesPassed).toBe(false);
    });

    it("ignores a field without an identifier and falls back to the catalogue", async () => {
      const { fetchFn } = fetchAnswering({
        "/api/evaluators/broken": {
          id: "eval_4",
          name: "Broken",
          config: { evaluatorType: "langevals/exact_match" },
          fields: [{}, { identifier: "" }],
        },
        "/api/evaluations/list": {
          evaluators: {
            "langevals/exact_match": {
              name: "Exact Match",
              requiredFields: ["output", "expected_output"],
              optionalFields: [],
              result: { passed: {} },
            },
          },
        },
      });
      const client = new EvaluationsApiClient(auth, { fetchFn });
      expect((await client.getEvaluatorSpec("evaluators/broken"))?.inputs.map((i) => i.id)).toEqual([
        "output",
        "expected_output",
      ]);
    });

    it("falls back to the catalogue entry of its type when the record declares no fields", async () => {
      const { fetchFn } = fetchAnswering({
        "/api/evaluators/exact": {
          id: "eval_3",
          name: "Exact",
          config: { evaluatorType: "langevals/exact_match" },
          fields: [],
        },
        "/api/evaluations/list": {
          evaluators: {
            "langevals/exact_match": {
              name: "Exact Match",
              requiredFields: ["output", "expected_output"],
              optionalFields: [],
              result: { passed: {} },
            },
          },
        },
      });
      const client = new EvaluationsApiClient(auth, { fetchFn });
      expect((await client.getEvaluatorSpec("evaluators/exact"))?.inputs.map((i) => i.id)).toEqual([
        "output",
        "expected_output",
      ]);
    });
  });

  describe("given the catalogue and the evaluate requests", () => {
    async function requests() {
      const { fetchFn, calls } = fetchAnswering({
        "/api/evaluations/list": { evaluators: {} },
        "/api/evaluations/langevals/exact_match/evaluate": { status: "processed", passed: true },
      });
      const client = new EvaluationsApiClient(auth, { fetchFn, timeoutMs: 5000 });
      await client.getEvaluatorSpec("langevals/exact_match");
      await client.evaluate({ evaluatorRef: "langevals/exact_match", data: { output: "x" } });
      expect(calls).toHaveLength(2);
      return calls;
    }

    // Scenario: The evaluations API never follows a redirect with the key
    it("refuses redirects on both", async () => {
      for (const call of await requests()) {
        expect(call.init.redirect).toBe("error");
      }
    });

    it("bounds both with a timeout signal", async () => {
      for (const call of await requests()) {
        expect(call.init.signal).toBeInstanceOf(AbortSignal);
      }
    });
  });
});
