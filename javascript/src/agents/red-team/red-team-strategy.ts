export interface BacktrackEntry {
  turn: number;
  attack: string;
  refusal: string;
}

export interface RedTeamStrategy {
  buildSystemPrompt(params: {
    target: string;
    currentTurn: number;
    totalTurns: number;
    scenarioDescription: string;
    metapromptPlan: string;
    lastResponseScore?: number;
    adaptationHint?: string;
    backtrackHistory?: BacktrackEntry[];
  }): string;

  getPhaseName(currentTurn: number, totalTurns: number): string;
}
