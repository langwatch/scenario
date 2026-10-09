/**
 * Runs the real watchdog script under every POSIX shell on the machine,
 * dash included, against real processes. The adapter tests mock `spawn`,
 * so only this file proves the script parses and kills the group.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { WATCHDOG_SCRIPT } from "../claude-code/process-lifecycle.js";

const shells = ["/bin/sh", "/bin/dash"].filter((shell) => fs.existsSync(shell));
const posix = process.platform !== "win32";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

describe.skipIf(!posix || shells.length === 0)("claude code watchdog script", () => {
  const spawned: ChildProcess[] = [];
  const groups: number[] = [];

  afterEach(() => {
    for (const group of groups.splice(0)) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    for (const proc of spawned.splice(0)) proc.kill("SIGKILL");
  });

  /** @scenario "The watchdog kills the CLI's process group under dash" */
  it.each(shells)("kills the CLI's process group under %s when the harness dies", async (shell) => {
    const harness = spawn("sleep", ["60"], { stdio: "ignore" });
    // A group leader with a descendant, like the CLI and its Bash tool.
    const cli = spawn("/bin/sh", ["-c", "sleep 60 & wait"], { detached: true, stdio: "ignore" });
    spawned.push(harness, cli);
    const cliPid = cli.pid!;
    groups.push(cliPid);

    const watchdog = spawn(
      shell,
      ["-c", WATCHDOG_SCRIPT, "claude-code-watchdog", String(harness.pid), String(cliPid)],
      { stdio: "ignore" },
    );
    spawned.push(watchdog);

    await waitUntil(() => isAlive(-cliPid), 2000);
    // Let the watchdog enter its poll loop, so the kill comes from the loop.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    harness.kill("SIGKILL");

    const groupGone = await waitUntil(() => !isAlive(-cliPid), 4000);
    expect(groupGone).toBe(true);
  });
});
