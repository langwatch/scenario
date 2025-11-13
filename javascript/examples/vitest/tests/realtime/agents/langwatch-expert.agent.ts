import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";
import { MCPServerStdio } from "@openai/agents-core";

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
export function createLangwatchExpertSession(): RealtimeSession {
  console.log("VITE_LANGWATCH_API_KEY", import.meta.env.VITE_LANGWATCH_API_KEY);

  const langwatchMCP = new MCPServerStdio({
    fullCommand: `npx -y @langwatch/mcp-server --apiKey=${
      import.meta.env.VITE_LANGWATCH_API_KEY
    }`,
  });

  const agent = new RealtimeAgent({
    name: "LangWatch Expert",
    instructions:
      "You are a friendly and knowledgeable LangWatch expert. You have access to the MCP tools for fetching documents",
    voice: "coral" as const,
    mcpServers: [langwatchMCP],
  });

  return new RealtimeSession(agent, {
    model: "gpt-4o-realtime-preview-2024-12-17" as const,
    tracingDisabled: true,
  });
}
