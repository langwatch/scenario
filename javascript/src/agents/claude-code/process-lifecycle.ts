/**
 * Keeps a spawned Claude Code CLI from outliving the process that spawned it.
 *
 * A `claude -p` run spawns its own children: the shell commands of its Bash
 * tool, a test runner, a dev server, a Python venv. When the harness that
 * spawned Claude dies with it still running (a test runner killed under memory
 * pressure, a Ctrl-C, a session restart) nothing tells those processes to
 * stop. They reparent to pid 1 and keep running, burning tokens and memory
 * into a pipe nobody reads.
 *
 * Three measures, each covering a case the others cannot:
 *
 *  1. The CLI is spawned as the leader of its own process group, so a kill
 *     aimed at the group reaches every descendant, not only the CLI.
 *  2. On the harness's own `exit` the live groups get SIGKILL. That covers a
 *     normal exit, `process.exit()` and an uncaught exception.
 *  3. A watchdog shell process, detached from both, polls the harness pid and
 *     kills the group when the harness is gone. That covers SIGKILL and any
 *     other death that runs no JavaScript. The watchdog exits by itself the
 *     moment the CLI exits, so a healthy turn leaves nothing behind.
 *
 * Process groups and the watchdog are POSIX. On Windows the CLI is spawned as
 * before and only measure 2 applies.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const posix = process.platform !== "win32";

/**
 * The watchdog. `$1` is the harness pid, `$2` the CLI pid, which is also its
 * process group id (see {@link ownProcessGroup}). It polls once a second while
 * both are alive, then either exits, when the CLI finished on its own, or
 * terminates the CLI's group when the harness went first.
 */
const WATCHDOG_SCRIPT = [
  'harness="$1"; child="$2"',
  'while kill -0 "$harness" 2>/dev/null && kill -0 "$child" 2>/dev/null; do sleep 1; done',
  'kill -0 "$child" 2>/dev/null || exit 0',
  'kill -TERM -- "-$child" 2>/dev/null',
  "sleep 5",
  'kill -KILL -- "-$child" 2>/dev/null',
  "exit 0",
].join("\n");

/** The name the watchdog shows in `ps`, so a reader knows what it is. */
const WATCHDOG_NAME = "claude-code-watchdog";

/**
 * Spawn options that make the CLI the leader of its own process group, so
 * {@link killProcessTree} can reach its descendants.
 */
export function ownProcessGroup(): Pick<SpawnOptions, "detached"> {
  return { detached: posix };
}

/**
 * Send `signal` to the CLI and everything it spawned. Falls back to the CLI
 * alone where a group kill is not possible (Windows, or a child that never
 * got a pid).
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (posix && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is already gone; the child itself may still answer.
    }
  }
  child.kill(signal);
}

/** The kills to run when this process exits, one per live CLI. */
const onExitKills = new Set<() => void>();
let exitHookInstalled = false;

/**
 * SIGKILL the group of every CLI still running. This is what the harness's
 * `exit` runs; a test calls it directly, since emitting `exit` on the real
 * process would run the test runner's own handlers.
 */
export function killGuardedProcesses(): void {
  for (const kill of onExitKills) kill();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", killGuardedProcesses);
}

/**
 * Arms measures 2 and 3 for a freshly spawned CLI. Returns the function that
 * disarms them once the CLI has exited on its own.
 */
export function guardAgainstOrphaning(child: ChildProcess): () => void {
  const killOnExit = () => killProcessTree(child, "SIGKILL");
  onExitKills.add(killOnExit);
  installExitHook();

  if (posix && child.pid !== undefined) {
    const watchdog = spawn(
      "/bin/sh",
      ["-c", WATCHDOG_SCRIPT, WATCHDOG_NAME, String(process.pid), String(child.pid)],
      { detached: true, stdio: "ignore" },
    );
    // The watchdog must not keep the harness alive, and must not die with it.
    watchdog.unref?.();
  }

  return () => {
    onExitKills.delete(killOnExit);
  };
}
