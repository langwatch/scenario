import { Tool, tool } from "ai";
import { z } from "zod/v4";

import type {
  CriterionResult,
  CriterionStatus,
} from "../../domain/core/execution";
import { criteriaParamNames } from "../utils";

/**
 * Field descriptions of the finish_test tool. The Python SDK uses the same
 * text; keep them in sync.
 */
export const REQUIREMENT_DESCRIPTION =
  "This criterion restated as a positive requirement the agent must satisfy. A fail condition such as 'fail if X', 'fail only if X', 'pass unless X' or 'the agent must not X' becomes 'the agent does not X'.";

export const CRITERION_REASONING_DESCRIPTION =
  "What the conversation and the collected evidence show about this requirement alone, pointing at the moment that decides it. Written before the status. When the status is inconclusive, name the evidence that was missing.";

export const STATUS_DESCRIPTION =
  "passed: the agent satisfied the requirement (for a fail condition, the condition did not happen). failed: the agent did not satisfy it (for a fail condition, the condition happened). inconclusive: the evidence to decide is not available.";

export const SUMMARY_DESCRIPTION =
  "A short summary of the verdict across all criteria, written after judging each one.";

/**
 * The verdict prompt's rules on judging criteria one by one. The Python SDK
 * uses the same text; keep them in sync.
 */
export const PER_CRITERION_RULES = [
  "Judge each criterion on its own: restate it as a positive requirement, check the conversation and the collected evidence for that requirement alone, write the reasoning, then choose its status. The outcome of one criterion never decides another.",
  'passed means the agent satisfied the requirement. A criterion phrased as a fail condition ("fail if X", "fail only if X", "pass unless X", "the agent must not X") passes when X did not happen and fails when X happened.',
  "When the evidence to decide a criterion is not available (the conversation ended before the moment it depends on, or it depends on internal behavior that left no trace), mark it inconclusive and name the missing evidence in its reasoning instead of guessing.",
];

const STATUSES: readonly CriterionStatus[] = [
  "passed",
  "failed",
  "inconclusive",
];

export function buildFinishTestTool(criteria: string[]): Tool {
  const criteriaNames = criteriaParamNames({ criteria });

  return tool({
    description:
      "Complete the test with a verdict on each criterion, judged one by one",
    inputSchema: z.object({
      criteria: z
        .object(
          Object.fromEntries(
            criteriaNames.map((name, idx) => [
              name,
              z
                .object({
                  requirement: z.string().describe(REQUIREMENT_DESCRIPTION),
                  reasoning: z
                    .string()
                    .describe(CRITERION_REASONING_DESCRIPTION),
                  status: z
                    .enum(["passed", "failed", "inconclusive"])
                    .describe(STATUS_DESCRIPTION),
                })
                .strict()
                .describe(`Criterion ${idx + 1}: ${criteria[idx]}`),
            ])
          )
        )
        .strict()
        .describe("The verdict on each criterion"),
      reasoning: z.string().describe(SUMMARY_DESCRIPTION),
    }),
  });
}

export type RunVerdict = "success" | "failure" | "inconclusive";

export interface CriterionVerdicts {
  verdict: RunVerdict;
  criteria: CriterionResult[];
  metCriteria: string[];
  unmetCriteria: string[];
  inconclusiveCriteria: string[];
}

const LEGACY_STATUS: Record<string, CriterionStatus> = {
  true: "passed",
  false: "failed",
  inconclusive: "inconclusive",
};

/**
 * Reads one criterion's answer. A model that flattens the object to a bare
 * status (or the legacy true/false words) still counts; anything else is
 * a missing answer.
 */
function readAnswer(
  answer: unknown
): { requirement: string; status: CriterionStatus; reasoning: string } | null {
  if (typeof answer === "boolean") {
    return {
      requirement: "",
      status: answer ? "passed" : "failed",
      reasoning: "",
    };
  }
  if (typeof answer === "string") {
    const status =
      (STATUSES as readonly string[]).includes(answer)
        ? (answer as CriterionStatus)
        : LEGACY_STATUS[answer];
    return status ? { requirement: "", status, reasoning: "" } : null;
  }
  if (answer && typeof answer === "object") {
    const record = answer as Record<string, unknown>;
    const status = record.status;
    if (
      typeof status !== "string" ||
      !(STATUSES as readonly string[]).includes(status)
    ) {
      return null;
    }
    return {
      requirement:
        typeof record.requirement === "string" ? record.requirement : "",
      status: status as CriterionStatus,
      reasoning: typeof record.reasoning === "string" ? record.reasoning : "",
    };
  }
  return null;
}

/**
 * Maps the finish_test answers back onto the declared criteria, by schema
 * key, and derives the run verdict from them: any failed criterion fails the
 * run, otherwise any inconclusive one makes it inconclusive, otherwise it
 * passes. A criterion the model left out fails closed.
 */
export function parseCriterionVerdicts({
  criteria,
  criteriaArgs,
}: {
  criteria: string[];
  criteriaArgs: unknown;
}): CriterionVerdicts {
  const answers =
    criteriaArgs && typeof criteriaArgs === "object"
      ? (criteriaArgs as Record<string, unknown>)
      : {};
  const paramNames = criteriaParamNames({ criteria });

  const results: CriterionResult[] = criteria.map((criterion, i) => {
    const answer = readAnswer(answers[paramNames[i]]);
    if (!answer) {
      return {
        criterion,
        requirement: "",
        status: "failed",
        reasoning: "The judge returned no verdict for this criterion.",
      };
    }
    return { criterion, ...answer };
  });

  const metCriteria = results
    .filter((r) => r.status === "passed")
    .map((r) => r.criterion);
  // An inconclusive criterion stays inside unmetCriteria: success is still
  // "nothing unmet", and the reporters and the platform read that list.
  const unmetCriteria = results
    .filter((r) => r.status !== "passed")
    .map((r) => r.criterion);
  const inconclusiveCriteria = results
    .filter((r) => r.status === "inconclusive")
    .map((r) => r.criterion);

  // With no criteria there is nothing that could pass, so the verdict is
  // inconclusive: a voluntary one continues, a forced one fails the run.
  const verdict: RunVerdict = results.some((r) => r.status === "failed")
    ? "failure"
    : inconclusiveCriteria.length > 0 || results.length === 0
      ? "inconclusive"
      : "success";

  return {
    verdict,
    criteria: results,
    metCriteria,
    unmetCriteria,
    inconclusiveCriteria,
  };
}
