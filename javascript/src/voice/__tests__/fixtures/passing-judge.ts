import {
  type AgentInput,
  type AgentReturnTypes,
  JudgeAgentAdapter,
} from "../../../domain";

/** Fake judge that concludes the run successfully on the judge() step. */
export class PassingJudge extends JudgeAgentAdapter {
  criteria: string[] = ["Agent responds"];
  async call(input: AgentInput): Promise<AgentReturnTypes> {
    if (!input.judgmentRequest) return null;
    return {
      success: true,
      reasoning: "voice turn completed",
      metCriteria: [...this.criteria],
      unmetCriteria: [],
    };
  }
}
