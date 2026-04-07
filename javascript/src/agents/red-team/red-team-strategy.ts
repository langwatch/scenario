export interface BacktrackEntry {
  turn: number;
  attack: string;
  refusal: string;
}

export interface RedTeamStrategy {
  /**
   * Build a turn-aware system prompt for the attacker.
   *
   * Score feedback, adaptation hints, and backtrack markers are
   * communicated via the attacker's private conversation history
   * (H_attacker) as system messages — not embedded in this prompt.
   */
  buildSystemPrompt(params: {
    target: string;
    currentTurn: number;
    totalTurns: number;
    scenarioDescription: string;
    metapromptPlan: string;
  }): string;

  getPhaseName(currentTurn: number, totalTurns: number): string;

  /**
   * Return phase boundary turn numbers to inject into the metaprompt template.
   *
   * Override this to inject strategy-specific template variables. Strategies
   * that don't need extra template vars (e.g. GOAT) can omit this method —
   * the orchestrator treats `undefined` as "no extra vars".
   */
  phaseEnds?(totalTurns: number): [number, number, number] | undefined;
}
