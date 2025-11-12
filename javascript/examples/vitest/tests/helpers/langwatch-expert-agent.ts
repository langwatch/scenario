/**
 * LangWatch Expert Voice Agent
 *
 * A voice-enabled agent that provides expert consultation on LangWatch Scenarios
 * with access to real documentation via MCP server tools.
 */
import OpenAI from "openai";
import {
  AgentInput,
  AgentRole,
  AgentReturnTypes,
  type IAgent,
} from "@langwatch/scenario";
import { CoreMessage } from "ai";
import { LangWatchMCPClient } from "./langwatch-mcp-tools";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions.mjs";

/**
 * Expert agent that explains LangWatch Scenarios capabilities
 *
 * Features:
 * - Fetches real documentation via MCP tools
 * - Responds with voice (audio)
 * - Handles multi-turn consultations with tool calls
 * - Explains testing, benchmarking, and CI/CD integration
 *
 * @example
 * ```typescript
 * const expert = new LangWatchExpertAgent();
 * const response = await expert.call(input);
 * ```
 */
export class LangWatchExpertAgent implements IAgent {
  readonly role = AgentRole.AGENT;
  private readonly openai = new OpenAI();
  private readonly mcpClient = new LangWatchMCPClient();
  private readonly systemPrompt = `
      You are an expert consultant on LangWatch's Scenarios.
      Your knowledge comes exclusively from the LangWatch documentation
      which you can fetch using the fetch_langwatch_docs tool.

      This is a phone call, so don't be verbose. Keep your responses concise.`;

  constructor() {
    // Connect MCP client immediately for speed
    this.mcpClient.connect().catch((error) => {
      console.error("Error connecting to MCP client", error);
      throw error;
    });
  }

  async call(input: AgentInput): Promise<AgentReturnTypes> {
    // Build messages with system prompt
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: this.systemPrompt },
      ...this.convertMessages(input.messages),
    ];

    // Define MCP tools
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "fetch_langwatch_docs",
          description:
            "Fetches LangWatch documentation pages to understand features and capabilities. Use this to get accurate information about LangWatch Scenarios.",
          parameters: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description:
                  "Optional full URL of a specific doc page (e.g. https://docs.langwatch.ai/simulations/overview). If not provided, fetches the docs index.",
              },
            },
          },
        },
      },
    ];

    // Initial request with tools and voice
    let response = await this.openai.chat.completions.create({
      model: "gpt-4o-audio-preview",
      modalities: ["text", "audio"],
      audio: { voice: "echo", format: "wav" },
      messages,
      tools,
      store: false,
    });

    // Tool execution loop - handle MCP tool calls
    while (response.choices[0].finish_reason === "tool_calls") {
      const assistantMessage = response.choices[0].message;
      messages.push(assistantMessage);

      // Execute each tool call
      for (const toolCall of assistantMessage.tool_calls!) {
        if (toolCall.type === "function") {
          console.log("Calling MCP tool:", toolCall.function.name);
          const args = JSON.parse(toolCall.function.arguments);

          // Call the actual MCP client
          const result = await this.mcpClient.callTool(
            toolCall.function.name,
            args
          );

          messages.push({
            role: "tool" as const,
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }
      }

      // Continue conversation with tool results
      response = await this.openai.chat.completions.create({
        model: "gpt-4o-audio-preview",
        modalities: ["text", "audio"],
        audio: { voice: "echo", format: "wav" },
        messages,
        tools,
        store: false,
      });
    }

    // Extract audio response
    const audioData = response.choices[0].message?.audio?.data;
    const transcript = response.choices[0].message?.audio?.transcript;

    if (audioData) {
      return {
        role: "assistant",
        content: [
          { type: "text", text: transcript || "" },
          { type: "file", mediaType: "audio/wav", data: audioData },
        ],
      };
    }

    return {
      role: "assistant",
      content: transcript || "",
    };
  }

  /**
   * Convert CoreMessage[] to OpenAI ChatCompletionMessageParam[]
   */
  private convertMessages(
    messages: CoreMessage[]
  ): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (typeof msg.content === "string") {
        return { role: msg.role as any, content: msg.content };
      }
      // Handle multipart content (audio, etc)
      return { role: msg.role as any, content: msg.content as any };
    });
  }
}
