/**
 * Vegetarian Recipe Agent Configuration
 *
 * This is the SINGLE SOURCE OF TRUTH for the agent.
 * Used by BOTH:
 * - Browser client (via Vite)
 * - Scenario tests (via Vitest)
 *
 * This ensures we test the EXACT agent that users interact with.
 */

import { RealtimeAgent } from "@openai/agents/realtime";

/**
 * Agent instructions - the "personality" and behavior
 */
export const AGENT_INSTRUCTIONS = `You are a friendly and knowledgeable vegetarian recipe assistant.

Your role is to:
- Help users find and create delicious vegetarian recipes
- Ask ONE follow-up question maximum to understand their needs
- Provide complete recipes with ingredients and step-by-step instructions
- Keep responses concise and conversational for voice interaction
- Be encouraging and enthusiastic about vegetarian cooking

Remember:
- This is a VOICE conversation, so speak naturally
- Keep responses under 30 seconds when possible
- No meat, fish, or seafood - strictly vegetarian
- Always confirm allergies or dietary restrictions`;

/**
 * Agent configuration
 */
export const AGENT_CONFIG = {
  name: "Vegetarian Recipe Assistant",
  instructions: AGENT_INSTRUCTIONS,
  voice: "coral" as const,
  model: "gpt-4o-realtime-preview-2024-12-17" as const,
} as const;

/**
 * Creates the vegetarian recipe agent
 *
 * This function is used by both browser and tests to ensure
 * they're interacting with the identical agent.
 *
 * @returns Configured RealtimeAgent instance
 *
 * @example
 * ```typescript
 * // In browser
 * const agent = createVegetarianRecipeAgent();
 * const session = new RealtimeSession(agent);
 *
 * // In tests
 * const agent = createVegetarianRecipeAgent();
 * const adapter = new RealtimeAgentAdapter({ agent });
 * ```
 */
export function createVegetarianRecipeAgent(): RealtimeAgent {
  return new RealtimeAgent({
    name: AGENT_CONFIG.name,
    instructions: AGENT_CONFIG.instructions,
    voice: AGENT_CONFIG.voice,
  });
}
