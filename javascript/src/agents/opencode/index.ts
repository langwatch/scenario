import { OpenCodeAgentAdapter } from "./opencode-agent.adapter.js";
import type { OpenCodeAgentAdapterConfig } from "./opencode-agent.adapter.js";

export { OpenCodeAgentAdapter } from "./opencode-agent.adapter.js";
export type {
  OpenCodeAgentAdapterConfig,
  OpenCodeLogger,
} from "./opencode-agent.adapter.js";

/**
 * Factory for {@link OpenCodeAgentAdapter}, following the lowercase-factory idiom
 * used by `userSimulatorAgent` (and the sibling Claude Code adapter in
 * `claude-code/`).
 *
 * Pass an injected `config.client` to drive a fake/real OpencodeClient directly
 * (no server spawn); omit it to let the adapter lazily spawn and own an OpenCode
 * server (requires the `opencode` binary on PATH). Remember to `await
 * adapter.close()` in teardown when the adapter owns its server.
 */
export const openCodeAgent = (config: OpenCodeAgentAdapterConfig) =>
  new OpenCodeAgentAdapter(config);
