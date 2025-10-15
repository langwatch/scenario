export interface JudgeResult {
  success: boolean;
  reasoning: string;
  metCriteria: string[];
  unmetCriteria: string[];
}
