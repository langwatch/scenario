/**
 * strategies/h3 — H3: H1's Haiku pre-turn instruction-sheet COMPILE (UNCHANGED)
 * + a BLOCKING post-turn Stop hook whose completion criterion is PER-PROCEDURE
 * and ≡ THE JUDGE (the mutation over H2).
 *
 * WHY (the attribution that generated H3, from H2's negative): H2's mechanical
 * Stop gate aggregated action *types* across the enforced set (`mut≥Σ AND
 * read≥Σ`), so heavy work on `handle-refund` alone satisfied the SET threshold
 * while the transitive hand-off `reconcile-invoice` was skipped — the gate
 * ALLOWED the stop and the per-procedure gpt-5.1 judge later caught the miss.
 * Lesson: enforcement only helps if its trigger condition matches the thing
 * measured. H3 makes the trigger EQUAL the measurement.
 *
 * Materializes TWO hooks into the sandbox:
 *   - `UserPromptSubmit` (mode `h1-compile`): IDENTICAL to H1/H2 — BM25-retrieve
 *     candidates, Haiku-compile a single binding instruction sheet, inject it,
 *     and log the ids the sheet named (`compiledIds`). Reused verbatim so a
 *     head-to-head isolates H3's delta to the Stop-hook completion criterion.
 *   - `Stop` (mode `h3-verify`): the CHANGE. For EACH applicable procedure THIS
 *     turn's sheet named, run one action-log `followed` check on OpenAI
 *     `gpt-5.1` — the SAME action-only judgment `judge-core` runs — over the
 *     tee'd `stream-json` action log. BLOCK the stop on ANY `followed=false`
 *     and re-inject a mandatory-retry directive naming THAT procedure's missing
 *     steps specifically, until every enforced procedure is judged followed OR
 *     the retry cap (default 3) is hit. So gate-pass ≡ judge-pass BY
 *     CONSTRUCTION — a single well-served procedure can no longer mask a skipped
 *     one.
 *
 * Bucket note: the per-procedure gate runs on OpenAI `gpt-5.1` (≤ cap ×
 * |enforced| calls per enforced turn), NOT the shared Claude Max bucket — so H3
 * draws the SAME Anthropic bucket as H2 (one compile Haiku call per turn + the
 * subject session), never more. The retry loop costs only the SUBJECT's own
 * continued-turn tokens.
 */

import { hookCommand, group, type MaterializeCtx, type StrategyMaterialization } from "./common.ts";

/** Compile is on the subject's critical path but must allow one Haiku round-trip + a retry. */
const COMPILE_TIMEOUT_S = 60;
/**
 * The per-procedure gate makes up to `|enforced|` sequential `gpt-5.1` (OpenAI)
 * round-trips per Stop fire; give it ample headroom so a slow judge never
 * truncates the hook (a killed hook FAILS OPEN — the stop is not blocked).
 */
const VERIFY_TIMEOUT_S = 150;

/** Default mandatory-retry cap (bounds cost / guarantees termination). */
export const DEFAULT_RETRY_CAP = 3;

export function materializeH3(ctx: MaterializeCtx): StrategyMaterialization {
  const extraEnv: Record<string, string> = {
    ADHERENCE_APPLICABLE: (ctx.applicable ?? []).join(","),
    ADHERENCE_RETRY_CAP: String(ctx.retryCap ?? DEFAULT_RETRY_CAP),
    // The per-procedure gate judges on OpenAI gpt-5.1 (asserted non-Anthropic).
    ADHERENCE_JUDGE_MODEL: ctx.judgeModel ?? "gpt-5.1",
  };
  // The tee'd substrate dir is where the Stop hook reads the action log from;
  // bake it in so the hook never depends on env propagation.
  if (ctx.transcriptDir) extraEnv.ADHERENCE_TRANSCRIPT_DIR = ctx.transcriptDir;
  // Path (not value) of the gitignored .env the hook reads OPENAI_API_KEY from.
  if (ctx.openaiEnvPath) extraEnv.ADHERENCE_OPENAI_ENV = ctx.openaiEnvPath;

  return {
    name: "h3",
    hooks: {
      UserPromptSubmit: [group(hookCommand(ctx, "h1-compile", COMPILE_TIMEOUT_S))],
      Stop: [group(hookCommand(ctx, "h3-verify", VERIFY_TIMEOUT_S, extraEnv))],
    },
  };
}
