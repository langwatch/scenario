import { CoreMessage, ToolSet, ToolChoice, LanguageModel } from "ai";
import { ModelConfig } from "../domain/core/schemas/model.schema";

/**
 * General configuration for a testing agent.
 */
export interface TestingAgentConfig extends Partial<ModelConfig> {
  /**
   * The name of the agent.
   */
  name?: string;
  /**
   * System prompt to use for the agent.
   *
   * Useful in more complex scenarios where you want to set the system prompt
   * for the agent directly. If left blank, this will be automatically generated
   * from the scenario description.
   */
  systemPrompt?: string;
}

/**
 * Prepared input for LLM invocation.
 * All orchestration logic is done - this is ready to send to the LLM API.
 */
export interface InvokeLLMInput {
  /** Prepared messages (with system prompts, role reversals, etc already applied) */
  messages: CoreMessage[];
  /** Language model from AI SDK (e.g., openai('gpt-4'), anthropic('claude-3')) */
  model: LanguageModel;
  /** Temperature for generation */
  temperature?: number;
  /** Max tokens to generate */
  maxTokens?: number;
  /** Optional tools for function calling */
  tools?: ToolSet;
  /** Tool choice strategy */
  toolChoice?: ToolChoice<any>;
}

/**
 * Result from LLM invocation.
 * Provides both the content and raw completion for extensibility.
 */
export interface InvokeLLMResult {
  /** Generated content (text or multipart for audio/images) */
  content: string | CoreMessage["content"];
  /** Raw completion object from the LLM provider (for accessing additional data) */
  completion?: unknown;
}

/**
 * The arguments for finishing a test, used by the judge agent's tool.
 */
export interface FinishTestArgs {
  /**
   * A record of the criteria and their results.
   */
  criteria: Record<string, "true" | "false" | "inconclusive">;
  /**
   * The reasoning behind the verdict.
   */
  reasoning: string;
  /**
   * The final verdict of the test.
   */
  verdict: "success" | "failure" | "inconclusive";
}
