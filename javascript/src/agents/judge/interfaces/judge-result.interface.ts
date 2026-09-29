import type { CriterionResult } from "../../../domain/core/execution";

export interface JudgeResult {
  success: boolean;
  reasoning: string;
  metCriteria: string[];
  unmetCriteria: string[];
  /**
   * The criteria the judge answered `inconclusive`: it could not tell from
   * the evidence whether they were met. They are also listed in
   * {@link unmetCriteria}, so success stays "nothing unmet"; this list only
   * separates "could not tell" from "judged false". Absent when the verdict
   * left nothing inconclusive.
   */
  inconclusiveCriteria?: string[];
  /**
   * The verdict on each criterion with its own reasoning, in declared order.
   * Absent when the judge failed before judging any criterion.
   */
  criteria?: CriterionResult[];
}
