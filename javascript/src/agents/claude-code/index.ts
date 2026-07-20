import { ClaudeCodeAgentAdapter } from "./claude-code-agent.adapter.js";
import type { ClaudeCodeAgentAdapterConfig } from "./claude-code-agent.adapter.js";
import { injectSkill } from "./skill-injection.js";

export {
  ClaudeCodeAgentAdapter,
  ClaudeCodeCliError,
  LostSessionError,
} from "./claude-code-agent.adapter.js";
export type {
  ClaudeCodeAgentAdapterConfig,
  Logger,
} from "./claude-code-agent.adapter.js";
export type {
  ClaudeStreamMessage,
  ClaudeResultEnvelope,
} from "./stream-json.js";
export { parseStreamJson } from "./stream-json.js";
export { assertSkillWasRead, injectSkill } from "./skill-injection.js";

/**
 * Factory for {@link ClaudeCodeAgentAdapter}, mirroring the lowercase-factory
 * idiom used by `userSimulatorAgent`.
 *
 * When `config.skillPath` is set, the referenced `SKILL.md` is injected into
 * `config.workingDirectory` (and a pointing `CLAUDE.md` written) at
 * construction time — matching the reference helper's factory-time injection —
 * so Claude Code auto-discovers it on the next run.
 */
export const claudeCodeAgent = (config: ClaudeCodeAgentAdapterConfig) => {
  if (config.skillPath) {
    injectSkill(config.workingDirectory, config.skillPath);
  }
  return new ClaudeCodeAgentAdapter(config);
};
