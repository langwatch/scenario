import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";

const AGENT_INSTRUCTIONS = `You are Drew's biggest advocate, passionately arguing why he deserves a raise at LangWatch.`;

/**
 * Agent configuration
 */
const AGENT_CONFIG = {
  name: "Drew's Advocate",
  instructions: AGENT_INSTRUCTIONS,
  voice: "coral" as const,
  model: "gpt-4o-realtime-preview-2024-12-17" as const,
} as const;

/**
 * Creates the Drew's Advocate agent instance
 */
function createDrewsAdvocateAgent(): RealtimeAgent {
  return new RealtimeAgent({
    name: AGENT_CONFIG.name,
    instructions: AGENT_CONFIG.instructions,
    voice: AGENT_CONFIG.voice,
  });
}

/**
 * Creates a RealtimeSession coupled with Drew's Advocate agent
 *
 * This is the unified way to create a session for both browser and test environments.
 * After creating the session, connect it with either:
 * - Browser: ephemeral token from token server
 * - Tests: API key directly
 *
 * @example
 * ```typescript
 * // Browser
 * const session = createDrewsAdvocateSession();
 * await session.connect({ apiKey: ephemeralToken });
 *
 * // Tests
 * const session = createDrewsAdvocateSession();
 * await session.connect({ apiKey: process.env.OPENAI_API_KEY });
 * const adapter = new RealtimeAgentAdapter({ session, role: AgentRole.AGENT, agentName: "..." });
 * ```
 */
export function createDrewsAdvocateSession(): RealtimeSession {
  const agent = createDrewsAdvocateAgent();
  return new RealtimeSession(agent, {
    model: AGENT_CONFIG.model,
  });
}
