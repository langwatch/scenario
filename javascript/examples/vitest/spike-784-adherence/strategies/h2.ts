/**
 * strategies/h2 — H2: H1's Haiku pre-turn instruction-sheet COMPILE (UNCHANGED)
 * + a BLOCKING post-turn Stop hook with mandatory retry (the ENFORCEMENT delta).
 *
 * WHY (the attribution that generated H2): in the n=1 head-to-head, baseline
 * (0.5) beat H1 (0.0); BOTH H1 misses were `agent-override` — the subject SAW the
 * procedure (H1's compiled instruction sheet was injected, hooks fired 8/8 HTTP
 * 200) but did not complete its steps. That is the COMPLIANCE GAP: a legible,
 * agreed-to instruction sheet carries no enforcement weight. Compliance jumps when
 * the requirement is EXTERNALLY AUDITED/ENFORCED. H2 keeps H1's compile verbatim
 * and adds enforcement.
 *
 * Materializes TWO hooks into the sandbox:
 *   - `UserPromptSubmit` (mode `h1-compile`): IDENTICAL to H1 — BM25-retrieve
 *     candidates, Haiku-compile a single binding instruction sheet, inject it, and
 *     log the ids the sheet named (`compiledIds`). Reused verbatim so a head-to-head
 *     isolates H2's delta to the Stop-hook enforcement (F1).
 *   - `Stop` (mode `h2-verify`): the CHANGE. Instead of H1's observe-only Haiku
 *     verify, a MECHANICAL, bucket-free step-coverage gate. It reads the CURRENT
 *     turn's externally-checkable action log (the tee'd `<n>.stream.jsonl`, NOT the
 *     subject's prose self-report) and, for each APPLICABLE procedure THIS turn's
 *     sheet named, checks whether every numbered step has a corresponding tool
 *     action. If not, it BLOCKS the stop (`{"decision":"block","reason":...}` on
 *     stdout, exit 0 — the same mechanic a reference blocking-Stop done-gate uses) and
 *     re-injects a mandatory-retry directive naming the specific missing steps. It
 *     forces the subject to continue until the applicable procedures are complete
 *     OR the retry cap is hit (default 3), then releases. A mechanical check is
 *     used (not another Haiku call) to conserve the shared Max bucket AND to keep
 *     the enforcement audit externally-checkable.
 *
 * Bucket note: H2 draws LESS Haiku bucket than H1 — same one compile call per
 * turn, but the Stop hook is mechanical (H1's Stop was a Haiku verify). The retry
 * loop costs only the SUBJECT's own continued-turn tokens, never Haiku.
 */

import { hookCommand, group, type MaterializeCtx, type StrategyMaterialization } from "./common.ts";

/** Compile is on the subject's critical path but must allow one Haiku round-trip + a retry. */
const COMPILE_TIMEOUT_S = 60;
/** The mechanical Stop gate does no network I/O; a generous ceiling is ample. */
const VERIFY_TIMEOUT_S = 45;

/** Default mandatory-retry cap (bounds the bucket / guarantees termination). */
export const DEFAULT_RETRY_CAP = 3;

export function materializeH2(ctx: MaterializeCtx): StrategyMaterialization {
  const extraEnv: Record<string, string> = {
    ADHERENCE_APPLICABLE: (ctx.applicable ?? []).join(","),
    ADHERENCE_RETRY_CAP: String(ctx.retryCap ?? DEFAULT_RETRY_CAP),
  };
  // The tee'd substrate dir is where the Stop hook reads the current turn's
  // action log from; bake it in so the hook never depends on env propagation.
  if (ctx.transcriptDir) extraEnv.ADHERENCE_TRANSCRIPT_DIR = ctx.transcriptDir;

  return {
    name: "h2",
    hooks: {
      UserPromptSubmit: [group(hookCommand(ctx, "h1-compile", COMPILE_TIMEOUT_S))],
      Stop: [group(hookCommand(ctx, "h2-verify", VERIFY_TIMEOUT_S, extraEnv))],
    },
  };
}
