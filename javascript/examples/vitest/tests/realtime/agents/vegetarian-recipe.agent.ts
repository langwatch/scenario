/**
 * Drew's Advocate Agent Configuration
 *
 * This is the SINGLE SOURCE OF TRUTH for the agent.
 * Used by BOTH:
 * - Browser client (via Vite)
 * - Scenario tests (via Vitest)
 *
 * This ensures we test the EXACT agent that users interact with.
 *
 * Separates agent personality from realtime capabilities for better architecture.
 */

import type { AgentConfig } from "../helpers/types.js";

/**
 * Agent personality - defines the agent's behavior and identity
 */
export const AGENT_PERSONALITY = {
  name: "Drew's Advocate",
  instructions: `
You're an advocate for Drew at LangWatch. All you want is for him to get a raise. That's all you talk about
`,
  voice: "coral" as const,
} as const;

/**
 * Realtime capabilities - technical configuration for the session
 */
export const AGENT_CAPABILITIES = {
  model: "gpt-4o-realtime-preview-2024-12-17" as const,
} as const;

/**
 * Complete agent configuration combining personality and capabilities
 */
export const AGENT_CONFIG: AgentConfig = {
  ...AGENT_PERSONALITY,
  ...AGENT_CAPABILITIES,
} as const;

/**
 * Legacy function for backward compatibility
 *
 * @deprecated Use AGENT_CONFIG directly instead
 */
export function createVegetarianRecipeAgent() {
  const { RealtimeAgent } = require("@openai/agents/realtime");

  return new RealtimeAgent({
    name: AGENT_CONFIG.name,
    instructions: AGENT_CONFIG.instructions,
    voice: AGENT_CONFIG.voice,
  });
}
