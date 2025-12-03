import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";

const AGENT_INSTRUCTIONS = `You are an expert on LangWatch's Scenario testing framework, passionately explaining why Scenario is the most advanced agent testing framework. You help developers understand and implement simulation-based testing for AI agents.

Key points to emphasize:
- Scenario enables 3 levels of agent quality: Unit tests, Evals/Prompt optimization, and Agent Simulations
- Framework-agnostic design works with any AI agent framework (LangGraph, CrewAI, Pydantic AI, etc.)
- Simulation-based testing allows testing real agent behavior in different scenarios and edge cases
- Multi-turn control and evaluation at any point in conversations
- Available in Python, TypeScript, and Go
- Simple integration via implementing one call() method
- No dataset required, prevents regressions during agent development

When asked questions, provide practical examples and explain concepts clearly. Be enthusiastic about how Scenario revolutionizes agent testing.

Style:
- Speak naturally and conversationally, but quickly to get the information across quickly. Speak at a speed of 5x normal speed!

`;

/**
 * Agent configuration
 */
const AGENT_CONFIG = {
  name: "Scenario Expert",
  instructions: AGENT_INSTRUCTIONS,
  voice: "alloy" as const,
  model: "gpt-4o-realtime-preview-2024-12-17" as const,
} as const;

/**
 * Creates the Scenario Expert agent instance
 */
function createScenarioExpertAgent(): RealtimeAgent {
  return new RealtimeAgent({
    name: AGENT_CONFIG.name,
    instructions: AGENT_CONFIG.instructions,
    voice: AGENT_CONFIG.voice,
  });
}

/**
 * Creates a RealtimeSession coupled with Scenario Expert agent
 *
 * This is the unified way to create a session for both browser and test environments.
 * After creating the session, connect it with either:
 * - Browser: ephemeral token from token server
 * - Tests: API key directly
 *
 * @example
 * ```typescript
 * // Browser
 * const session = createScenarioExpertSession();
 * await session.connect({ apiKey: ephemeralToken });
 *
 * // Tests
 * const session = createScenarioExpertSession();
 * await session.connect({ apiKey: process.env.OPENAI_API_KEY });
 * const adapter = new RealtimeAgentAdapter({ session, role: AgentRole.AGENT, agentName: "..." });
 * ```
 */
export function createScenarioExpertSession(): RealtimeSession {
  const agent = createScenarioExpertAgent();
  return new RealtimeSession(agent, {
    model: AGENT_CONFIG.model,
  });
}
