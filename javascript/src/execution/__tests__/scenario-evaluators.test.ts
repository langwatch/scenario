// Ref: specs/scenario-evaluators.feature
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AgentRole,
  AgentAdapter,
  JudgeAgentAdapter,
  type AgentInput,
  type AgentReturnTypes,
  type ScenarioEvaluator,
} from "../../domain";
import { UserSimulatorAgentAdapter } from "../../domain/agents";
import { evaluator, field, trace } from "../../evaluators/mappings";
import { ScenarioEventType, type ScenarioRunFinishedEvent } from "../../events";
import { user, agent, judge } from "../../script";
import { ScenarioExecution } from "../scenario-execution";

const getEvaluatorSpec = vi.fn();
const evaluate = vi.fn();

vi.mock("../../evaluators/evaluations-api", () => ({
  resolveEvaluationsApiAuth: () => ({
    endpoint: "http://localhost",
    apiKey: "sk-test",
    projectId: undefined,
  }),
  EvaluationsApiClient: vi.fn().mockImplementation(function () {
    return {
      getEvaluatorSpec: (ref: string) => getEvaluatorSpec(ref),
      evaluate: (args: unknown) => evaluate(args),
    };
  }),
}));

vi.mock("../../config/get-project-config", () => ({
  getProjectConfig: vi.fn().mockResolvedValue(null),
}));

class SqlAgent extends AgentAdapter {
  role = AgentRole.AGENT;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return [
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call_1",
            toolName: "run_sql",
            input: { sql: "SELECT 1" },
          },
        ],
      },
      { role: "assistant" as const, content: "The answer is 1." },
    ];
  }
}

class MockUserSimulatorAgent extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return "What is one?";
  }
}

class MockJudgeAgent extends JudgeAgentAdapter {
  criteria = ["Answers the question"];
  async call(input: AgentInput) {
    if (!input.judgmentRequest) return null;
    return {
      success: true,
      reasoning: "All criteria passed",
      metCriteria: this.criteria,
      unmetCriteria: [],
    };
  }
}

async function runWith(evaluators?: ScenarioEvaluator[]) {
  const execution = new ScenarioExecution(
    {
      name: "chargebacks",
      description: "A user asks what one is",
      agents: [new SqlAgent(), new MockUserSimulatorAgent(), new MockJudgeAgent()],
      fields: { golden_sql: "SELECT 1" },
      evaluators,
    },
    [user("What is one?"), agent(), judge()],
    "batch-1"
  );
  const finished: ScenarioRunFinishedEvent[] = [];
  execution.events$.subscribe((event) => {
    if (event.type === ScenarioEventType.RUN_FINISHED) {
      finished.push(event as ScenarioRunFinishedEvent);
    }
  });
  const result = await execution.execute();
  return { result, finished };
}

describe("evaluators on a scenario execution", () => {
  beforeEach(() => {
    getEvaluatorSpec.mockReset();
    evaluate.mockReset();
    getEvaluatorSpec.mockResolvedValue({
      evaluatorId: "langevals/exact_match",
      name: "Exact Match",
      inputs: [
        { id: "output", required: true },
        { id: "expected_output", required: true },
      ],
      producesPassed: true,
    });
  });

  describe("given a scenario with one evaluator", () => {
    // Scenario: The run finished event carries the evaluations
    describe("when the run finishes", () => {
      it("sends the evaluation in the run finished event and on the result", async () => {
        evaluate.mockResolvedValue({ status: "processed", passed: true, details: "Match" });

        const { result, finished } = await runWith([
          evaluator("langevals/exact_match", {
            mappings: {
              output: trace.toolCall("run_sql").input,
              expected_output: field("golden_sql"),
            },
          }),
        ]);

        expect(evaluate).toHaveBeenCalledWith(
          expect.objectContaining({
            evaluatorRef: "langevals/exact_match",
            data: { output: { sql: "SELECT 1" }, expected_output: "SELECT 1" },
          })
        );
        expect(finished).toHaveLength(1);
        expect(finished[0].results?.evaluations).toEqual([
          {
            evaluatorId: "langevals/exact_match",
            name: "Exact Match",
            status: "passed",
            required: true,
            passed: true,
            details: "Match",
            inputs: { output: '{"sql":"SELECT 1"}', expected_output: "SELECT 1" },
          },
        ]);
        expect(result.evaluations).toEqual(finished[0].results?.evaluations);
        expect(result.success).toBe(true);
        expect(finished[0].results?.verdict).toBe("success");
      });

      it("fails the run when a required evaluator fails", async () => {
        evaluate.mockResolvedValue({ status: "processed", passed: false, details: "No match" });

        const { result, finished } = await runWith([
          evaluator("langevals/exact_match", {
            mappings: {
              output: trace.toolCall("run_sql").input,
              expected_output: field("golden_sql"),
            },
          }),
        ]);

        expect(result.success).toBe(false);
        expect(result.reasoning).toContain("Evaluator Exact Match failed: No match");
        expect(finished[0].status).toBe("FAILED");
        expect(finished[0].results?.verdict).toBe("failure");
        expect(finished[0].results?.evaluations?.[0].status).toBe("failed");
      });
    });
  });

  describe("given a scenario with no evaluators", () => {
    // Scenario: A run without evaluators sends no evaluations
    it("sends no evaluations key", async () => {
      const { result, finished } = await runWith(undefined);
      expect(evaluate).not.toHaveBeenCalled();
      expect(finished[0].results).not.toHaveProperty("evaluations");
      expect(result.evaluations).toBeUndefined();
    });
  });
});
