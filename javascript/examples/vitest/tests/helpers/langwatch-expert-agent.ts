/**
 * LangWatch Expert Voice Agent
 *
 * A voice-enabled agent that provides expert consultation on LangWatch Scenarios
 * with access to real documentation via MCP server tools.
 */
import { AgentInput, AgentRole } from "@langwatch/scenario";
import { ModelMessage } from "ai";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { OpenAiVoiceAgent } from "./openai-voice-agent";
import { fetchLangWatchDocs, LangWatchMCPClient } from "./langwatch-mcp-tools";
import {
  ChatCompletion,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions.mjs";

/**
 * Simplified message structure for OpenAI API
 */
interface SimpleMessage {
  role: string;
  content: string;
}

/**
 * Expert agent that explains LangWatch Scenarios capabilities
 *
 * Features:
 * - Fetches real documentation via MCP tools
 * - Responds with voice (audio)
 * - Handles multi-turn consultations
 * - Explains testing, benchmarking, and CI/CD integration
 *
 * @example
 * ```typescript
 * const expert = new LangWatchExpertAgent();
 * const response = await expert.call(input);
 * ```
 */
export class LangWatchExpertAgent extends OpenAiVoiceAgent {
  role: AgentRole = AgentRole.AGENT;

  private readonly mcpClient = new LangWatchMCPClient();

  constructor() {
    super({
      systemPrompt: `
      You are an expert consultant on LangWatch's Scenarios.
      Your knowledge comes exclusively from the LangWatch documentation

      which you can fetch using the fetch_langwatch_docs tool.

      This is a phone call, so don't be verbose. Keep your responses concise.`,
      voice: "echo",
    });

    // Connect right away for speed
    this.mcpClient.connect().catch((error) => {
      console.error("Error connecting to MCP client", error);
      throw error;
    });
  }
  protected async respondWithAudio(
    messages: ChatCompletionMessageParam[]
  ): Promise<ChatCompletion> {
    const allMessages = this.systemMessage
      ? [this.systemMessage, ...messages]
      : messages;

    const tools = [
      {
        type: "function" as const,
        function: {
          name: "fetch_langwatch_docs",
          description:
            "Fetches LangWatch documentation pages from the internet to understand features and capabilities. Use this to get accurate information about LangWatch Scenarios.",
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

    // Initial request with tools
    let response = await this.openai.chat.completions.create({
      model: "gpt-4o-audio-preview",
      modalities: ["text", "audio"],
      audio: { voice: this.config.voice, format: "wav" },
      messages: allMessages,
      tools,
      store: false,
    });

    // Tool execution loop
    while (response.choices[0].finish_reason === "tool_calls") {
      const assistantMessage = response.choices[0].message;
      allMessages.push(assistantMessage);

      // Execute each tool call
      for (const toolCall of assistantMessage.tool_calls!) {
        console.log("toolCall", toolCall);
        const args = JSON.parse(toolCall.function.arguments);

        // Call the actual MCP client
        const result = await this.mcpClient.callTool(
          toolCall.function.name,
          args
        );

        allMessages.push({
          role: "tool" as const,
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }

      // Continue conversation with tool results
      response = await this.openai.chat.completions.create({
        model: "gpt-4o-audio-preview",
        modalities: ["text", "audio"],
        audio: { voice: this.config.voice, format: "wav" },
        messages: allMessages,
        tools,
        store: false,
      });
    }

    return response;
  }
}
