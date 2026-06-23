import { OpenCodeAgentAdapter } from "./opencode-agent.adapter.js";
import type { OpenCodeAgentAdapterConfig } from "./opencode-agent.adapter.js";

export { OpenCodeAgentAdapter } from "./opencode-agent.adapter.js";
export type {
  OpenCodeAgentAdapterConfig,
  Logger,
} from "./opencode-agent.adapter.js";

/**
 * Factory for {@link OpenCodeAgentAdapter}, mirroring the lowercase-factory idiom
 * used by `userSimulatorAgent` and the Claude Code sibling's `claudeCodeAgent`.
 *
 * Pass an injected `config.client` to drive a fake/real OpencodeClient directly
 * (no server spawn); omit it to let the adapter lazily spawn and own an OpenCode
 * server (requires the `opencode` binary on PATH). Remember to `await
 * adapter.close()` in teardown when the adapter owns its server.
 */
export const openCodeAgent = (config: OpenCodeAgentAdapterConfig) =>
  new OpenCodeAgentAdapter(config);
