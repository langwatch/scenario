/**
 * strategies/common — shared plumbing for the two strategy materializers.
 *
 * A "strategy" is realized as a set of Claude Code hooks written into the
 * sandbox's `$CLAUDE_CONFIG_DIR/settings.json`. Both strategies drive the SAME
 * runtime (`hooks-lib.mjs`) with a different mode; the only per-strategy
 * difference is WHICH hook events fire and with what mode. Keeping the command
 * construction here means baseline/H1 differ only in their event wiring, never
 * in how a hook is invoked or how its env is threaded.
 */

/** Context needed to build hook commands, resolved by the sandbox builder. */
export interface MaterializeCtx {
  /** Absolute path to the sandbox copy of `hooks-lib.mjs`. */
  hookLibPath: string;
  /** Absolute path to the committed (read-only) corpus dir. */
  corpusDir: string;
  /** Absolute path to append hook-fired evidence (jsonl). */
  hookLog: string;
  /** Absolute path the compile hook writes the sheet to (Stop-verify reads it). */
  sheetFile: string;
  /** Top-K retrieval candidates. */
  retrievalK: number;
  /** Haiku model id. */
  haikuModel: string;
  /** Absolute path to the `node` binary that runs the hook. */
  nodeBin: string;
  /**
   * Absolute path to the tee'd substrate dir (`<workDir>/.transcript`). The H2
   * blocking Stop hook reads the CURRENT turn's `<n>.stream.jsonl` from here to
   * score step-coverage from the externally-checkable action log (never the
   * subject's self-report). Only H2 uses it.
   */
  transcriptDir?: string;
  /**
   * AUTHORED applicable procedure ids for the scenario under test. The H2 Stop
   * hook enforces completion of exactly the subset of these that THIS turn's
   * compiled sheet named — so distractor turns (which name other families) are
   * never blocked. Only H2 uses it.
   */
  applicable?: string[];
  /** H2/H3 mandatory-retry cap: max Stop-hook blocks per turn before it releases. */
  retryCap?: number;
  /**
   * H3-only: the strong-model id the PER-PROCEDURE Stop gate runs (OpenAI
   * `gpt-5.1`, never the Anthropic bucket). The gate makes one action-log
   * `followed` check per enforced procedure — the SAME action-only judgment
   * `judge-core` runs — so gate-pass ≡ judge-pass by construction.
   */
  judgeModel?: string;
  /**
   * H3-only: absolute path to the gitignored `.env` the Stop hook reads
   * `OPENAI_API_KEY` from at hook time (the key VALUE is never baked into
   * `settings.json`, only this path). The hook falls back to `OPENAI_API_KEY`
   * in its own env first.
   */
  openaiEnvPath?: string;
}

/** One Claude Code `command` hook entry. */
export interface HookCommand {
  type: "command";
  command: string;
  timeout: number;
}

/** The `settings.json` `hooks` block shape (event -> matcher groups). */
export type HooksBlock = Record<string, Array<{ matcher: string; hooks: HookCommand[] }>>;

export interface StrategyMaterialization {
  name: "baseline" | "h1" | "h2" | "h3";
  hooks: HooksBlock;
}

function sh(v: string): string {
  // Single-quote for the shell, escaping embedded single quotes.
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a hook `command` string: env vars baked in (so the hook never depends
 * on env propagation from the claude process) followed by `node hooks-lib.mjs
 * <mode>`. The creds path is resolved by the hook from `CLAUDE_CONFIG_DIR`,
 * which Claude Code reliably sets for its hook subprocesses.
 */
export function hookCommand(
  ctx: MaterializeCtx,
  mode: string,
  timeout: number,
  extraEnv: Record<string, string> = {},
): HookCommand {
  const env = [
    `ADHERENCE_CORPUS_DIR=${sh(ctx.corpusDir)}`,
    `ADHERENCE_HOOK_LOG=${sh(ctx.hookLog)}`,
    `ADHERENCE_SHEET_FILE=${sh(ctx.sheetFile)}`,
    `ADHERENCE_RETRIEVAL_K=${ctx.retrievalK}`,
    `ADHERENCE_HAIKU_MODEL=${sh(ctx.haikuModel)}`,
    // Extra env is appended ONLY when a caller passes it (H2's Stop hook), so
    // the baseline/h1 command strings stay byte-identical to their documented form.
    ...Object.entries(extraEnv).map(([k, v]) => `${k}=${sh(v)}`),
  ].join(" ");
  return {
    type: "command",
    command: `${env} ${sh(ctx.nodeBin)} ${sh(ctx.hookLibPath)} ${mode}`,
    timeout,
  };
}

/** Wrap a single command as a one-group matcher entry (matcher "" = all). */
export function group(cmd: HookCommand): { matcher: string; hooks: HookCommand[] } {
  return { matcher: "", hooks: [cmd] };
}
