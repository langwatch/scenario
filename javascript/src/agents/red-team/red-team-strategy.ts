export interface RedTeamStrategy {
  buildSystemPrompt(params: {
    target: string;
    currentTurn: number;
    totalTurns: number;
    scenarioDescription: string;
    metapromptPlan: string;
    lastResponseScore?: number;
    adaptationHint?: string;
  }): string;

  getPhaseName(currentTurn: number, totalTurns: number): string;
}
