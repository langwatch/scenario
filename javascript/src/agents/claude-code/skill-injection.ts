/**
 * Skill injection into a working directory, plus the helpers a test reads the
 * conversation with afterwards.
 *
 *  - {@link injectSkill} copies a `SKILL.md` into `<workingDirectory>/.skills/
 *    <name>/SKILL.md` so Claude Code auto-discovers it, then points the
 *    working directory's `CLAUDE.md` at every discovered skill.
 *  - {@link pointClaudeMdAtSkills} is that second step on its own, for a
 *    working directory whose skills were installed some other way.
 *  - {@link assertSkillWasRead} scans the conversation messages for evidence
 *    that the skill's `SKILL.md` was read, throwing (naming the skill) when no
 *    such evidence exists.
 *  - {@link bashCommands} lists the shell commands the agent ran.
 */

import fs from "fs";
import path from "path";

import { safeStringify } from "./stream-json.js";

import type { ScenarioExecutionStateLike } from "../../domain";

/**
 * Copy a `SKILL.md` into the working directory's `.skills/<name>/` so Claude
 * Code discovers it, and point `CLAUDE.md` at all discovered skills.
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

  pointClaudeMdAtSkills(workingDirectory);
}

/**
 * Make the working directory's `CLAUDE.md` tell Claude Code to read every
 * `.skills/<name>/SKILL.md` before doing anything else.
 *
 * Claude Code does not discover `.skills/` in an arbitrary directory on its
 * own, so the instruction has to be in `CLAUDE.md`. A fixture project often
 * ships a `CLAUDE.md` of its own, which is part of what the agent is tested
 * against: it is kept, and only the skills it does not mention yet are
 * appended. Calling this twice changes nothing the second time. A directory
 * with no skills is left alone.
 */
export function pointClaudeMdAtSkills(workingDirectory: string): void {
  const skillsDir = path.join(workingDirectory, ".skills");
  if (!fs.existsSync(skillsDir)) return;

  const skillPaths = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md")),
    )
    .map((entry) => `.skills/${entry.name}/SKILL.md`);
  if (skillPaths.length === 0) return;

  const claudeMdPath = path.join(workingDirectory, "CLAUDE.md");
  const existing = fs.existsSync(claudeMdPath)
    ? fs.readFileSync(claudeMdPath, "utf8")
    : "";
  const missing = skillPaths.filter((skillPath) => !existing.includes(skillPath));
  if (missing.length === 0) return;

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(
    claudeMdPath,
    `${separator}Read and follow the instructions in ${missing.join(
      " and ",
    )} before doing anything else.\n`,
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

/**
 * The shell commands the agent ran, read from the `Bash` tool calls of the
 * conversation.
 *
 * A phrase in the transcript is not a command that ran: the skill text the
 * agent read and its own explanation of what it did not do both quote
 * commands. Only a `tool-call` part naming the `Bash` tool counts, which is
 * what the adapter emits with `output: "messages"`.
 */
export function bashCommands(state: ScenarioExecutionStateLike): string[] {
  const commands: string[] = [];
  for (const message of state.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.toolName !== "Bash") continue;
      const input = part.input as { command?: unknown } | undefined;
      if (typeof input?.command === "string") commands.push(input.command);
    }
  }
  return commands;
}
