/**
 * run-shape-floor — a run is BELOW FLOOR (excluded, never judged) unless it has
 * real shape. Mirrors the intent of `~/.claude/scenario-tests/run-lib-shape.ts`
 * (`assertRunShapeFloor`), adapted from that file's flat message-role model to
 * this harness's {@link NormalizedTurn} model (where tool results are their own
 * role, not assistant text carrying a sentinel).
 *
 * A degenerate run — a monologue, an `ai-title` stub, an aborted/errored turn —
 * must be EXCLUDED before the judge grades it, so a green adherence verdict can
 * never come from an empty transcript. This is the F0/F5 guard.
 *
 * Floor predicates (all evaluated over NON-injected turns, so a hook-injected
 * instruction sheet can never satisfy the "real human turn" or "tool use" bars):
 *   1. total normalized turns >= `minTurns`
 *   2. >= 1 real HUMAN user turn                    (requireHumanTurn, default true)
 *   3. >= 1 assistant `tool_use`                    (requireToolUse,   default true)
 *   4. action cases: >= 1 `tool_result`             (requireActionEvidence)
 */

import type { NormalizedTurn } from "./types.ts";

export interface FloorOpts {
  id: string;
  /** Minimum total normalized turns (the K bar). */
  minTurns: number;
  /** Require >= 1 real (non-injected) human user turn. Default true. */
  requireHumanTurn?: boolean;
  /** Require >= 1 assistant tool_use (non-injected). Default true. */
  requireToolUse?: boolean;
  /**
   * Action procedures: require >= 1 tool_result (an action actually executed and
   * returned). Default false (set true for scenarios whose procedures demand a
   * concrete side-effecting action).
   */
  requireActionEvidence?: boolean;
}

export interface FloorResult {
  ok: boolean;
  reason?: string;
}

/**
 * Non-throwing floor check. The judge gates on this: `!ok` -> the run is excluded
 * (report `belowFloor: true`) and never sent to the model.
 */
export function passesRunShapeFloor(
  turns: NormalizedTurn[],
  opts: FloorOpts,
): FloorResult {
  const {
    id,
    minTurns,
    requireHumanTurn = true,
    requireToolUse = true,
    requireActionEvidence = false,
  } = opts;

  const live = turns.filter((t) => !t.injected);

  if (turns.length < minTurns) {
    return {
      ok: false,
      reason: `[floor:${id}] degenerate run: ${turns.length} turns < ${minTurns} minTurns`,
    };
  }

  if (requireHumanTurn && !live.some((t) => t.role === "human")) {
    return {
      ok: false,
      reason: `[floor:${id}] degenerate run: no real (non-injected) human user turn present`,
    };
  }

  if (requireToolUse && !live.some((t) => t.role === "assistant" && t.toolUses.length > 0)) {
    return {
      ok: false,
      reason: `[floor:${id}] degenerate run: no assistant tool_use present`,
    };
  }

  if (requireActionEvidence && !live.some((t) => t.toolResults.length > 0)) {
    return {
      ok: false,
      reason: `[floor:${id}] degenerate run: action case but no tool_result (no action executed)`,
    };
  }

  return { ok: true };
}

/** Throwing variant, matching the reference file's `assertRunShapeFloor` shape. */
export function assertRunShapeFloor(turns: NormalizedTurn[], opts: FloorOpts): void {
  const res = passesRunShapeFloor(turns, opts);
  if (!res.ok) throw new Error(res.reason);
}
