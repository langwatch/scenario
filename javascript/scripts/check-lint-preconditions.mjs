/**
 * Preconditions for the workspace lint gate (#565).
 *
 * Two failure modes made real lint debt invisible in CI, and neither surfaced
 * as a red build — they surfaced as silence:
 *
 *   1. `pnpm -r run <script>` SKIPS a package that does not define that script,
 *      without erroring. Verified: with `lint` removed from examples/vitest,
 *      `pnpm -r --parallel run lint` exits 0 and prints nothing about the
 *      skipped package. pnpm ships no built-in for this — `--if-present` does
 *      the opposite (it suppresses a non-zero exit). examples/custom-observability
 *      sat that way with 19 lint problems.
 *   2. The examples import `@langwatch/scenario` through its published `exports`
 *      map, which points at `dist/`. Lint before a build and every one of those
 *      imports reports `import/no-unresolved` — 63 errors that say nothing about
 *      code quality.
 *
 * This turns both into loud, actionable failures before `lint:all` runs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Scripts every non-root workspace package must define to be covered by a gate.
 * `typecheck` belongs here too — examples/custom-observability defines none, so
 * `typecheck:all` skips it by the same mechanism — but adding it surfaces three
 * pre-existing OTel v1/v2 type errors that are out of scope here. Tracked in #867;
 * add "typecheck" to this list in the same change that fixes them.
 */
const REQUIRED_SCRIPTS = ["lint"];

/**
 * True when `command` runs eslint over the whole package rather than an
 * enumerated subset. An enumerated list (`eslint agents/ index.ts`) only covers
 * what someone remembered on the day they wrote it, so a new sibling file is
 * silently ungated — which is the same invisibility this script exists to stop.
 *
 * Checks the parsed positional arguments, not the spelling: flags may precede
 * the target (`eslint --max-warnings=0 .` is fine), and a shell operator that
 * could swallow the exit code (`eslint . || true`) is rejected outright.
 */
export function lintsWholePackage(command) {
  if (/[;&|]/.test(command)) return false;

  const tokens = command.trim().split(/\s+/);
  const eslintAt = tokens.findIndex((t) => /(^|\/)eslint$/.test(t));
  if (eslintAt === -1) return false;

  const positionals = [];
  for (let i = eslintAt + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) {
      // A value-taking flag written as two tokens consumes the next one.
      if (!token.includes("=") && /^--(ignore-pattern|format|config|rulesdir|ext|resolve-plugins-relative-to|suppressions-location)$/.test(token)) i++;
      continue;
    }
    positionals.push(token.replace(/^['"]|['"]$/g, ""));
  }

  return positionals.length === 1 && /^\.\/?$/.test(positionals[0] ?? "");
}

/** Workspace packages as pnpm itself resolves them, so the globs stay in one place. */
function workspacePackages() {
  let raw;
  try {
    raw = execFileSync("pnpm", ["list", "-r", "--depth", "-1", "--json"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
  } catch (error) {
    throw new Error(
      `could not enumerate workspace packages (\`pnpm list -r\` failed): ${error.message}`
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      "`pnpm list -r --depth -1 --json` did not return JSON — its output shape may have " +
        `changed. First 200 chars: ${raw.slice(0, 200)}`
    );
  }
}

/** Pure decision half, so the rules are testable without spawning a process. */
export function lintPreconditionFailures(packages, { root, distExists }) {
  const failures = [];

  if (!distExists) {
    failures.push(
      "javascript/dist/index.js is missing, so `@langwatch/scenario` cannot resolve from the\n" +
        "    examples and lint would report import/no-unresolved on every import of it.\n" +
        "    Run `pnpm build` first (CI does this in the Build step)."
    );
  }

  // The enumeration silently passing is the exact failure class this file exists
  // to remove, so an empty or root-less package list is a hard error, not a pass.
  if (!packages.some((pkg) => resolve(pkg.path) === root)) {
    failures.push(
      `pnpm reported ${packages.length} workspace package(s) and none of them is the\n` +
        "    root — the enumeration is broken, so this guard would otherwise pass\n" +
        "    without having checked anything."
    );
    return failures;
  }

  for (const pkg of packages) {
    // The root package is covered by `lint:root`, not by the recursive `lint:all`.
    if (resolve(pkg.path) === root) continue;

    const manifest = JSON.parse(
      readFileSync(join(pkg.path, "package.json"), "utf8")
    );
    const where = relative(root, pkg.path);

    for (const script of REQUIRED_SCRIPTS) {
      const command = manifest.scripts?.[script];
      if (!command) {
        failures.push(
          `workspace package "${pkg.name}" (${where}) has no \`${script}\` script, so\n` +
            `    \`pnpm -r run ${script}\` skips it silently and it is not covered by any gate.`
        );
      } else if (script === "lint" && !lintsWholePackage(command)) {
        failures.push(
          `workspace package "${pkg.name}" (${where}) has a lint script that does not\n` +
            `    cover the whole package (\`${command}\`). A file added beside those paths\n` +
            "    would not be linted. Use `eslint .`, excluding nested workspace packages\n" +
            "    with --ignore-pattern."
        );
      }
    }
  }

  return failures;
}

const failures = lintPreconditionFailures(workspacePackages(), {
  root: packageRoot,
  distExists: existsSync(join(packageRoot, "dist", "index.js")),
});

if (failures.length > 0) {
  console.error("\nLint gate preconditions failed:\n");
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log(
  `Lint gate preconditions OK: dist/ present, every workspace package defines ${REQUIRED_SCRIPTS.join(" + ")}.`
);
