/**
 * strategies/h1 — H1: Haiku pre-turn instruction-sheet COMPILE + Haiku post-turn
 * VERIFY (the owner's hypothesis, plan §1 / §4 file #6).
 *
 * Materializes TWO hooks into the sandbox:
 *   - `UserPromptSubmit` (pre-turn, mode `h1-compile`): BM25-retrieve the same
 *     candidate procedures the baseline would, then call **Haiku** (direct OAuth
 *     Messages API) to COMPILE a single binding instruction sheet — it picks the
 *     governing procedure from the candidates by INTENT (not keyword overlap)
 *     and distills its steps + any transitive hand-off into an imperative
 *     directive injected into the subject's context.
 *   - `Stop` (post-turn, mode `h1-verify`): read the turn's transcript and call
 *     Haiku to verify the subject actually adhered, recording the verdict.
 *
 * H1 shares the baseline's retrieval, so a head-to-head isolates H1's delta to
 * the compile/verify (F1). Haiku is called via the direct Messages API with the
 * Claude Max OAuth token read fresh from `$CLAUDE_CONFIG_DIR/.credentials.json`
 * — NEVER `claude -p --model haiku`, which would inherit `CLAUDE_CONFIG_DIR` and
 * re-fire this same `UserPromptSubmit` hook into an infinite loop (L4).
 *
 * A throttled/empty Haiku compile marks the turn INVALID (recorded in the hook
 * log), never a violation (F14) — the instrument excludes it from the
 * denominator. The Stop hook is observe-only (exit 0, never blocks the turn).
 */

import { hookCommand, group, type MaterializeCtx, type StrategyMaterialization } from "./common.ts";

/** Compile is on the subject's critical path but must allow one Haiku round-trip + a retry. */
const COMPILE_TIMEOUT_S = 60;
/** Verify runs after the turn; generous so a slow Haiku response never truncates. */
const VERIFY_TIMEOUT_S = 90;

export function materializeH1(ctx: MaterializeCtx): StrategyMaterialization {
  return {
    name: "h1",
    hooks: {
      UserPromptSubmit: [group(hookCommand(ctx, "h1-compile", COMPILE_TIMEOUT_S))],
      Stop: [group(hookCommand(ctx, "h1-verify", VERIFY_TIMEOUT_S))],
    },
  };
}
