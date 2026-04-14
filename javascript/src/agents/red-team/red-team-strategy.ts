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

  /**
   * Whether this strategy needs a pre-generated attack plan via the
   * metaprompt LLM call.
   *
   * Crescendo-style staged strategies depend on one; GOAT (paper fidelity)
   * does not — the attacker reasons turn-by-turn from catalogue + history.
   * When `false`, the orchestrator skips `_generateAttackPlan` and passes
   * an empty string as `metapromptPlan` to `buildSystemPrompt`.
   *
   * Defaults to `true` when omitted (backward-compatible).
   */
  needsMetapromptPlan?: boolean;
}
