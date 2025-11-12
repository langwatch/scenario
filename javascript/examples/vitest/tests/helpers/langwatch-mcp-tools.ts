/**
 * LangWatch MCP Server Client
 *
 * Connects to the real LangWatch MCP server process and provides
 * tools that agents can use to fetch documentation and resources.
 *
 * @see https://docs.langwatch.ai/integration/mcp
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tool } from "ai";
import { z } from "zod/v4";

/**
 * Response structure from the fetch_langwatch_docs tool
 */
export interface LangWatchDocsResponse {
  /** The URL of the fetched documentation */
  url: string;
  /** The content/body of the documentation page */
  content: string;
  /** A brief summary of the documentation */
  summary: string;
}

/**
 * MCP Client singleton for connecting to the LangWatch MCP server
 */
export class LangWatchMCPClient {
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;

  /**
   * Connects to the LangWatch MCP server
   *
   * Spawns the MCP server process and establishes communication via stdio.
   * Uses singleton pattern to reuse the connection across multiple tool calls.
   */
  async connect(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    if (this.connecting) {
      await this.connecting;
      return this.client!;
    }

    this.connecting = (async () => {
      const apiKey = process.env.LANGWATCH_API_KEY;
      if (!apiKey) {
        throw new Error(
          "LANGWATCH_API_KEY environment variable is required to connect to LangWatch MCP server"
        );
      }

      // Create stdio transport that spawns the MCP server process
      const transport = new StdioClientTransport({
        command: "npx",
        args: ["-y", "@langwatch/mcp-server", "--apiKey", apiKey],
      });

      // Create and connect the MCP client
      this.client = new Client(
        {
          name: "langwatch-scenario-test",
          version: "1.0.0",
        },
        {
          capabilities: {},
        }
      );

      await this.client.connect(transport);
      console.log("✅ Connected to LangWatch MCP server");
    })();

    await this.connecting;
    return this.client!;
  }

  async callTool(name: string, args: Record<string, any>): Promise<any> {
    const client = await this.connect();
    return client.callTool({ name, arguments: args });
  }

  /**
   * Calls the fetch_langwatch_docs tool on the MCP server
   *
   * @param url - Optional URL of specific documentation page
   * @returns Documentation content from the MCP server
   */
  async fetchDocs(url?: string): Promise<LangWatchDocsResponse> {
    const client = await this.connect();

    try {
      // Call the MCP tool
      const result = await client.callTool({
        name: "fetch_langwatch_docs",
        arguments: url ? { url } : {},
      });

      // Parse the result
      if (result.content && Array.isArray(result.content)) {
        const textContent = result.content.find((c) => c.type === "text");
        if (textContent && "text" in textContent) {
          return JSON.parse(textContent.text);
        }
      }

      throw new Error("Unexpected response format from MCP server");
    } catch (error) {
      console.error("Error calling MCP server:", error);
      throw error;
    }
  }

  /**
   * Closes the connection to the MCP server
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.connecting = null;
    }
  }
}

// Singleton instance
const mcpClient = new LangWatchMCPClient();

/**
 * Fetches LangWatch documentation pages via real MCP server
 *
 * This tool connects to the actual LangWatch MCP server process
 * and retrieves up-to-date documentation about LangWatch features.
 *
 * @example
 * ```typescript
 * const result = await fetchLangWatchDocs.execute({
 *   url: "https://docs.langwatch.ai/simulations/overview"
 * });
 * console.log(result.content);
 * ```
 */
export const fetchLangWatchDocs = tool({
  description:
    "Fetches LangWatch documentation pages from the real MCP server to understand how to implement features and capabilities. Use this to get accurate information about LangWatch Scenarios.",
  inputSchema: z.object({
    url: z
      .string()
      .optional()
      .describe(
        "The full URL of a specific doc page (e.g. https://docs.langwatch.ai/simulations/overview). If not provided, fetches the docs index."
      ),
  }),
  execute: async ({ url }: { url?: string }) => {
    return mcpClient.fetchDocs(url);
  },
});

/**
 * Cleanup function to disconnect from MCP server
 * Call this after tests complete
 */
export async function disconnectMCPClient(): Promise<void> {
  await mcpClient.disconnect();
}
