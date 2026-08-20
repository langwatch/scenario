/**
 * Shared resolution of the repository's `.feature` files for vitest-cucumber.
 *
 * Every cucumber-bound test needs an absolute path to the same feature file,
 * and each one used to count its own hops back to the repository root. The
 * count depends on how deep the test sits, so `src/voice/__tests__` needed four
 * and `src/agents/judge/__tests__` needed five, and 22 files each carried their
 * own copy of an answer that is only correct for where they happen to live.
 *
 * Anchoring on this module's location instead makes the depth a property of one
 * file. Moving a test no longer silently breaks its path, and moving `specs/`
 * is a single edit here.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root, three levels above `javascript/src/__tests__`. */
const REPO_ROOT = resolve(HERE, "..", "..", "..");

function featurePath(name: string): string {
  const path = resolve(REPO_ROOT, "specs", name);
  if (!existsSync(path)) {
    // loadFeature fails on a missing file with a parse error naming a path
    // nobody wrote, because it is assembled from hops. Say which file is
    // missing and where this looked, so a moved spec reads as a moved spec.
    throw new Error(
      `Feature file not found: ${path} (resolved from ${HERE} against specs/${name})`
    );
  }
  return path;
}

export const VOICE_AGENTS_FEATURE = featurePath("voice-agents.feature");
