export interface JudgeResult {
  success: boolean;
  reasoning: string;
  metCriteria: string[];
  unmetCriteria: string[];
  /**
   * Set when the judge could not reach a verdict for infrastructure reasons
   * (discovery budget exhausted, malformed tool call, no tool call at all).
   * Consumers must treat such a result as an errored run, never as a
   * security verdict (#888).
   */
  error?: string;
}
