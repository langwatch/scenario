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
import { fetchLangWatchDocs } from "./langwatch-mcp-tools";

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

  constructor() {
    super({
      systemPrompt: `You are an expert consultant on LangWatch Scenarios, a framework for testing AI agents through simulations.

You have access to LangWatch documentation through tools. When users ask about:
- User simulations for testing conversational AI
- Issue detection before deployment
- Benchmarking models and prompts
- CI/CD integration

Use the fetch_langwatch_docs tool to get accurate, up-to-date information.

Be conversational and natural since this is a voice conversation. Keep responses concise but informative.
Explain concepts clearly for someone new to agent testing.`,
      voice: "echo",
    });
  }

  /**
   * Processes input with tool access and generates voice response
   *
   * @param input - Agent input containing conversation messages
   * @returns Audio message or text response
   */
  public async call(input: AgentInput): Promise<ModelMessage | string> {
    try {
      const messages = this.convertToSimpleMessages(input.messages);

      // First pass: check if we need documentation via tools
      const response = await generateText({
        model: openai("gpt-4o"),
        messages: [
          {
            role: "system",
            content: this.getConsultantSystemPrompt(),
          },
          ...messages,
        ],
        tools: {
          fetch_langwatch_docs: fetchLangWatchDocs,
        },
        toolChoice: "auto",
        maxTokens: 500,
      });

      // Build enriched context from tool results
      const enrichedContext = this.buildEnrichedContext(response);

      // Generate audio response with enriched context
      const lastUserMessage = input.messages
        .filter((m) => m.role === "user")
        .pop();

      if (!lastUserMessage) {
        throw new Error("No user message found in input");
      }

      return super.call({
        ...input,
        messages: [
          {
            role: "user",
            content: this.formatEnrichedPrompt(
              lastUserMessage.content,
              enrichedContext,
              response.text
            ),
          },
        ],
      });
    } catch (error) {
      console.error("LangWatchExpertAgent failed:", error);
      throw error;
    }
  }

  /**
   * Builds system prompt for the consultant role
   */
  private getConsultantSystemPrompt(): string {
    return `You are an expert consultant on LangWatch Scenarios, a framework for testing AI agents through simulations.

When asked about scenario testing, explain these key capabilities:
- User simulations: Create realistic user interactions to stress-test conversational AI
- Issue detection: Find logic errors, hallucinations, and grounding issues before deployment
- Benchmarking: Compare models and prompts with quantitative metrics
- CI/CD integration: Automate testing in your development workflows

Be conversational and concise for voice.`;
  }

  /**
   * Converts ModelMessage array to simple message format
   */
  private convertToSimpleMessages(messages: ModelMessage[]): SimpleMessage[] {
    return messages.map((msg) => ({
      role: msg.role,
      content: this.extractTextContent(msg.content),
    }));
  }

  /**
   * Extracts text content from message content (handles string or array)
   */
  private extractTextContent(
    content: string | Array<{ type: string; text?: string }>
  ): string {
    if (typeof content === "string") {
      return content;
    }

    return (
      content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join(" ") || "..."
    );
  }

  /**
   * Builds enriched context from tool call results
   */
  private buildEnrichedContext(response: {
    toolResults?: Array<{ result: unknown }>;
  }): string {
    if (!response.toolResults || response.toolResults.length === 0) {
      return "";
    }

    return response.toolResults
      .map((result) => `Documentation: ${JSON.stringify(result.result)}`)
      .join("\n\n");
  }

  /**
   * Formats the final prompt with enriched context for audio generation
   */
  private formatEnrichedPrompt(
    userContent: string | Array<{ type: string; text?: string }>,
    enrichedContext: string,
    responseText: string
  ): string {
    const userText = this.extractTextContent(userContent);

    if (enrichedContext) {
      return `${userText}\n\nContext from documentation:\n${enrichedContext}`;
    }

    return `${userText}\n\nYour response: ${responseText}`;
  }
}

