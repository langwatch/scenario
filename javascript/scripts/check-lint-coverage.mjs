#!/usr/bin/env node
/**
 * Preconditions for the workspace lint gate (#565).
 *
 * Two failure modes made real lint debt invisible in CI, and neither surfaced
 * as a red build — they surfaced as silence:
 *
 *   1. `pnpm -r run lint` SKIPS a package that has no `lint` script, without
 *      erroring. `examples/custom-observability` sat that way with 19 problems.
 *   2. The examples import `@langwatch/scenario` through its published
 *      `exports` map, which points at `dist/`. Lint before a build and every
 *      one of those imports reports `import/no-unresolved` — 63 errors that
 *      say nothing about code quality.
 *
 * This script turns both into loud, actionable failures. It runs before
 * `lint:all`, so a contributor sees the real cause instead of a wall of
 * resolver noise or a green run that checked less than they think.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/** Workspace packages as pnpm itself resolves them, so the globs stay in one place. */
function workspacePackages() {
  const raw = execFileSync(
    "pnpm",
    ["list", "-r", "--depth", "-1", "--json"],
    { cwd: packageRoot, encoding: "utf8" }
  );
  return JSON.parse(raw);
}

const failures = [];

if (!existsSync(path.join(packageRoot, "dist"))) {
  failures.push(
    "javascript/dist is missing, so `@langwatch/scenario` cannot resolve from the\n" +
      "    examples and lint would report import/no-unresolved on every import of it.\n" +
      "    Run `pnpm build` first (CI does this in the Build step)."
  );
}

for (const pkg of workspacePackages()) {
  // The root package is linted by `lint:root`, not by the recursive `lint:all`.
  if (path.resolve(pkg.path) === packageRoot) continue;

  const manifestPath = path.join(pkg.path, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const lint = manifest.scripts?.lint;
  const where = path.relative(packageRoot, pkg.path);

  if (!lint) {
    failures.push(
      `workspace package "${pkg.name}" (${where}) has no\n` +
        "    `lint` script, so `pnpm -r run lint` skips it silently and its lint debt is\n" +
        "    invisible. Add one (`\"lint\": \"eslint .\"`) or the gate does not cover it."
    );
  } else if (!/^eslint \./.test(lint)) {
    // An enumerated file list (`eslint agents/ index.ts`) lints only what someone
    // remembered on the day they wrote it; a new sibling file is silently ungated.
    // `eslint .` plus --ignore-pattern for nested workspace packages is glob-complete.
    failures.push(
      `workspace package "${pkg.name}" (${where}) has an enumerated\n` +
        `    lint script (\`${lint}\`). A file added next to those paths would not be linted.\n` +
        "    Use `eslint .` and exclude nested workspace packages with --ignore-pattern."
    );
  }
}

if (failures.length > 0) {
  console.error("\nLint gate preconditions failed:\n");
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log(
  "Lint gate preconditions OK: dist/ present, every workspace package has a lint script."
);
