import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";
import { tool } from "@openai/agents";
import { z } from "zod/v4";

const fetchLangwatchDocsTool = tool({
  description:
    "Fetches the LangWatch docs for understanding how to implement LangWatch in your codebase. Always use this tool when the user asks for help with LangWatch. Start with 'START' to fetch the index and then follow the links to the relevant pages, always ending with `.md` extension",
  strict: true,
  parameters: z.object({
    url: z
      .string()
      .describe("The url to fetch. Start with 'START' to fetch the index.")
      .optional(),
  }),
  execute: async ({ url }) => {
    console.log("url", url);
    let urlToFetch = "";
    try {
      if (url?.trim().includes("START")) {
        urlToFetch = "https://docs.langwatch.ai/llms.txt";
      } else if (url && !url.endsWith(".md")) {
        urlToFetch = url + ".md";
      } else {
        urlToFetch = url ?? "";
      }

      // Use CORS proxy for browser-based tool execution
      const proxiedUrl = `https://corsproxy.io/?${encodeURIComponent(
        urlToFetch
      )}`;

      const response = await fetch(proxiedUrl, {
        headers: {
          Accept: "text/plain, text/markdown, */*",
        },
      });

      const text = await response.text();
      console.log("urlToFetch", urlToFetch, text);

      return text;
    } catch (error) {
      console.error("Error fetching LangWatch docs", error);
      return `Error fetching LangWatch docs for url ${urlToFetch}: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  },
});

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

  // const langwatchMCP = new MCPServerStdio({
  //   fullCommand: `npx -y @langwatch/mcp-server --apiKey=${
  //     import.meta.env.VITE_LANGWATCH_API_KEY
  //   }`,
  // });

  const agent = new RealtimeAgent({
    name: "LangWatch Expert",
    instructions:
      "You are a friendly and knowledgeable LangWatch expert. You have access to the MCP tools for fetching documents",
    voice: "coral" as const,
    tools: [fetchLangwatchDocsTool],
    // mcpServers: [langwatchMCP],
  });

  return new RealtimeSession(agent, {
    model: "gpt-4o-realtime-preview-2024-12-17" as const,
    tracingDisabled: true,
  });
}
