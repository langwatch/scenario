/**
 * Evaluators on scenarios: LangWatch evaluators check the answer against the
 * expected answer the scenario carries and the SQL the agent ran, next to the
 * judge verdict.
 *
 * Needs LANGWATCH_API_KEY (and LANGWATCH_ENDPOINT for a self-hosted
 * platform). The evaluators run through the LangWatch evaluate endpoint, so
 * the test is skipped without a key.
 */
import { openai } from "@ai-sdk/openai";
import scenario, {
  type AgentAdapter,
  AgentRole,
  type AgentInput,
  type AgentReturnTypes,
} from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

const SQL =
  "SELECT quarter, count(*) FROM chargebacks WHERE merchant = 'ACME Travel' GROUP BY quarter";
const ANSWER = "ACME Travel had 12 chargebacks in 2026-Q1 and 9 in 2026-Q2.";

/** An agent that answers with a run_sql tool call and a summary. */
const sqlAnalystAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_run_sql_1",
            toolName: "run_sql",
            input: { sql: SQL },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_run_sql_1",
            toolName: "run_sql",
            output: {
              type: "json",
              value: [
                { quarter: "2026-Q1", count: 12 },
                { quarter: "2026-Q2", count: 9 },
              ],
            },
          },
        ],
      },
      { role: "assistant", content: ANSWER },
    ];
  },
};

describe.skipIf(!process.env.LANGWATCH_API_KEY)("evaluators on scenarios", () => {
  it("checks the answer and the SQL with LangWatch evaluators", async () => {
    const result = await scenario.run({
      name: "chargeback totals by quarter",
      description:
        "A fraud analyst asks for the chargebacks per quarter for merchant ACME Travel.",
      agents: [
        sqlAnalystAgent,
        scenario.userSimulatorAgent({ model: openai("gpt-5-mini") }),
        scenario.judgeAgent({
          model: openai("gpt-5-mini"),
          criteria: ["The agent reports chargeback counts per quarter"],
        }),
      ],
      fields: {
        expected_answer: ANSWER,
        table_schema: "CREATE TABLE chargebacks (id text, merchant text, quarter text)",
      },
      evaluators: [
        // Inferred mappings: output reads the last agent message and
        // expected_output reads the expected_answer field.
        scenario.evaluator("langevals/exact_match", { required: true }),
        // The SQL the agent ran comes from the run_sql tool call.
        scenario.evaluator("langevals/llm_boolean", {
          required: false,
          mappings: { output: scenario.trace.toolCall("run_sql").input },
          settings: {
            prompt:
              "Does this SQL group chargebacks by quarter for one merchant? Answer true or false.",
          },
        }),
      ],
      script: [
        scenario.user("How many chargebacks did ACME Travel have per quarter?"),
        scenario.agent(),
        scenario.judge(),
      ],
    });

    expect(result.success, result.reasoning).toBe(true);
    const statuses = Object.fromEntries(
      (result.evaluations ?? []).map((evaluation) => [evaluation.evaluatorId, evaluation.status])
    );
    expect(statuses["langevals/exact_match"]).toBe("passed");
    expect(["passed", "failed"]).toContain(statuses["langevals/llm_boolean"]);
  });
});
