/**
 * Optional skill injection + a post-hoc assertion that a skill was actually
 * read during a scenario run.
 *
 * Ported from the install-orchard test helper (`claude-code-adapter.ts`):
 *  - {@link injectSkill} copies a `SKILL.md` into `<workingDirectory>/.skills/
 *    <name>/SKILL.md` so Claude Code auto-discovers it, then writes a `CLAUDE.md`
 *    that points at every discovered skill (only when one does not already
 *    exist).
 *  - {@link assertSkillWasRead} scans the conversation messages for evidence
 *    that the skill's `SKILL.md` was read, throwing (naming the skill) when no
 *    such evidence exists.
 *
 * Behavior is intentionally identical to the reference; only the typing and
 * module boundary changed.
 */

import fs from "fs";
import path from "path";

import { safeStringify } from "./stream-json.js";

import type { ScenarioExecutionStateLike } from "../../domain";

/**
 * Copy a `SKILL.md` into the working directory's `.skills/<name>/` so Claude
 * Code discovers it, and write a `CLAUDE.md` pointing at all discovered skills
 * (unless one already exists).
 *
 * The skill name is derived from the SKILL.md's parent directory name, matching
 * the reference helper (`path.basename(path.dirname(skillPath))`).
 *
 * NOTE: this performs EAGER filesystem writes (`mkdirSync` + `copyFileSync`),
 * and `copyFileSync` CLOBBERS any existing same-named skill copy at
 * `<workingDirectory>/.skills/<name>/SKILL.md`. This assumes a trusted-fixture
 * setup (a test/scratch working directory), not an arbitrary user dir.
 *
 * @param workingDirectory - The directory Claude Code is spawned in.
 * @param skillPath - Absolute path to a `SKILL.md` to inject.
 */
export function injectSkill(workingDirectory: string, skillPath: string): void {
  const skillName = path.basename(path.dirname(skillPath));
  const skillDir = path.join(workingDirectory, ".skills", skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.copyFileSync(skillPath, path.join(skillDir, "SKILL.md"));

  writeClaudeMdPointingToSkills(workingDirectory);
}

/**
 * Write a `CLAUDE.md` that instructs Claude Code to read every discovered
 * `.skills/<name>/SKILL.md` first. No-op when a `CLAUDE.md` already exists or no
 * skills are present.
 */
function writeClaudeMdPointingToSkills(workingDirectory: string): void {
  const skillsDir = path.join(workingDirectory, ".skills");
  const claudeMdPath = path.join(workingDirectory, "CLAUDE.md");

  if (!fs.existsSync(skillsDir) || fs.existsSync(claudeMdPath)) return;

  const skillDirs = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        fs.existsSync(path.join(skillsDir, d.name, "SKILL.md")),
    );

  if (skillDirs.length === 0) return;

  const instructions = skillDirs
    .map((d) => `.skills/${d.name}/SKILL.md`)
    .join(" and ");
  fs.writeFileSync(
    claudeMdPath,
    `Read and follow the instructions in ${instructions} before doing anything else.\n`,
  );
}

/**
 * Assert that the agent actually read the named skill's `SKILL.md` during the
 * run. Scans every message's content (stringifying array/object content via
 * `safeStringify`) for a reference to the named skill's
 * `.skills/<name>/SKILL.md` (or `skills/<name>/SKILL.md`) path.
 *
 * @param state - The scenario execution state (exposes `messages`).
 * @param skillName - The skill directory name to look for.
 * @throws {Error} naming the skill when no read evidence is found.
 */
export function assertSkillWasRead(
  state: ScenarioExecutionStateLike,
  skillName: string,
): void {
  const allContent = state.messages
    .map((m) =>
      typeof m.content === "string" ? m.content : safeStringify(m.content),
    )
    .join("\n");

  const hasSkillRead =
    allContent.includes(`.skills/${skillName}/SKILL.md`) ||
    allContent.includes(`skills/${skillName}/SKILL.md`);

  if (!hasSkillRead) {
    throw new Error(
      `Expected agent to read the ${skillName} SKILL.md file, but found no evidence ` +
        `of reading .skills/${skillName}/SKILL.md in the conversation. ` +
        `The agent may have ignored the skill and hallucinated instructions.`,
    );
  }
}
