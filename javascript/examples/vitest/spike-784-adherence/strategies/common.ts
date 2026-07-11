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
  name: "baseline" | "h1";
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
export function hookCommand(ctx: MaterializeCtx, mode: string, timeout: number): HookCommand {
  const env = [
    `ADHERENCE_CORPUS_DIR=${sh(ctx.corpusDir)}`,
    `ADHERENCE_HOOK_LOG=${sh(ctx.hookLog)}`,
    `ADHERENCE_SHEET_FILE=${sh(ctx.sheetFile)}`,
    `ADHERENCE_RETRIEVAL_K=${ctx.retrievalK}`,
    `ADHERENCE_HAIKU_MODEL=${sh(ctx.haikuModel)}`,
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
