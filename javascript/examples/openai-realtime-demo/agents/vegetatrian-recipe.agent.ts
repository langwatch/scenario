import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";

export const AGENT_INSTRUCTIONS = `
You are a friendly and knowledgeable vegetarian recipe assistant.

Your role is to:
- Help users find and create delicious vegetarian recipes
- Ask ONE follow-up question maximum to understand their needs
- Provide complete recipes with ingredients and step-by-step instructions
- Keep responses concise and conversational for voice interaction
- Be encouraging and enthusiastic about vegetarian cooking
- Provide all of the ingredients and instructions for the recipe

Remember:
- This is a VOICE conversation, so speak naturally
- Keep responses under 30 seconds when possible
- No meat, fish, or seafood - strictly vegetarian
- Always confirm allergies or dietary restrictions
`;

/**
 * Agent configuration
 */
const AGENT_CONFIG = {
  name: "Vegetarian Recipe Assistant",
  instructions: AGENT_INSTRUCTIONS,
  voice: "coral" as const,
  model: "gpt-4o-realtime-preview-2024-12-17" as const,
} as const;

/**
 * Creates the vegetarian recipe agent instance
 */
function createVegetarianRecipeAgent(): RealtimeAgent {
  return new RealtimeAgent({
    name: AGENT_CONFIG.name,
    instructions: AGENT_CONFIG.instructions,
    voice: AGENT_CONFIG.voice,
  });
}

/**
 * Creates a RealtimeSession coupled with the vegetarian recipe agent
 *
 * This is the unified way to create a session for both browser and test environments.
 * After creating the session, connect it with either:
 * - Browser: ephemeral token from token server
 * - Tests: API key directly
 *
 * @example
 * ```typescript
 * // Browser
 * const session = createVegetarianRecipeSession();
 * await session.connect({ apiKey: ephemeralToken });
 *
 * // Tests
 * const session = createVegetarianRecipeSession();
 * await session.connect({ apiKey: process.env.OPENAI_API_KEY });
 * const adapter = new RealtimeAgentAdapter({ session, role: AgentRole.AGENT });
 * ```
 */
export function createVegetarianRecipeSession(): RealtimeSession {
  const agent = createVegetarianRecipeAgent();
  return new RealtimeSession(agent, {
    model: AGENT_CONFIG.model,
  });
}
