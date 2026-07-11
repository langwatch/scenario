/**
 * strategies/baseline — the FAIR-RETRIEVAL baseline (plan §6 / F1).
 *
 * Materializes ONE `UserPromptSubmit` hook that runs a generic BM25 retriever
 * over the full synthetic corpus and injects the matched procedure **BODIES**
 * (full text, not pointer-lines) into the subject's context before it acts.
 *
 * This is the fair control: it isolates H1's delta to the Haiku COMPILE step,
 * NOT to "rule text beats a pathname". Both arms retrieve identically; only H1
 * adds the pre-turn compile + post-turn verify. If the baseline injected only
 * pointers/paths (or a store-crippled excerpt), a positive H1 result could not
 * be attributed to the compile — the single most likely FALSE "H1 works".
 *
 * The retrieval + injection logic lives in `hooks-lib.mjs` (mode `baseline`);
 * this module only WIRES it as a hook. No Haiku call, no Stop hook — the
 * baseline is retrieval-only.
 */

import { hookCommand, group, type MaterializeCtx, type StrategyMaterialization } from "./common.ts";

/** Pre-turn retrieval hooks can be quick; give BM25 over the full corpus ample room. */
const USERPROMPT_TIMEOUT_S = 30;

export function materializeBaseline(ctx: MaterializeCtx): StrategyMaterialization {
  return {
    name: "baseline",
    hooks: {
      UserPromptSubmit: [group(hookCommand(ctx, "baseline", USERPROMPT_TIMEOUT_S))],
    },
  };
}
