import { generateText } from "ai";
import { ModelConfig } from "../domain/core/schemas/model.schema";

/**
 * Parameters for LLM invocation.
 * Derived from generateText parameters for now.
 */
export type InvokeLLMParams = Parameters<typeof generateText>[0];

/**
 * Result from LLM invocation.
 * Derived from generateText return type for now.
 */
export type InvokeLLMResult = Pick<
  Awaited<ReturnType<typeof generateText>>,
  "text" | "content" | "toolCalls" | "toolResults" | "steps"
>;

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
 * Tool choice strategy for LLM invocation.
 * Can be "auto" | "required" | "none" | { type: "tool"; toolName: string }
 */
export type ToolChoiceOption =
  | "auto"
  | "required"
  | "none"
  | { type: "tool"; toolName: string };

/**
 * Parameters passed to invokeLLM for LLM invocation.
 * This represents what we actually pass internally, not the full AI SDK interface.
 */
export interface InvokeLLMParams {
  /**
   * The language model to use.
   */
  model: LanguageModel;
  /**
   * The messages to send to the LLM (already prepared with system prompts, role reversal, etc.).
   */
  messages: CoreMessage[];
  /**
   * Temperature for sampling (0.0-1.0).
   */
  temperature?: number;
  /**
   * Maximum number of output tokens.
   */
  maxOutputTokens?: number;
  /**
   * Tools available to the LLM (for tool-using agents like JudgeAgent).
   */
  tools?: ToolSet;
  /**
   * Tool choice strategy (for tool-using agents like JudgeAgent).
   */
  toolChoice?: ToolChoiceOption;
}

/**
 * Tool call from LLM invocation.
 */
export interface InvokeLLMToolCall {
  /**
   * The name of the tool being called.
   */
  toolName: string;
  /**
   * The input arguments for the tool call.
   */
  input: unknown;
  /**
   * Unique identifier for this tool call.
   */
  toolCallId: string;
}

/**
 * Result from invoking the LLM.
 * This is a minimal subset of what generateText returns - only the fields we actually use.
 */
export interface InvokeLLMResult {
  /**
   * The text response from the LLM (if any).
   */
  text?: string;
  /**
   * Tool calls made by the LLM (if any).
   */
  toolCalls?: InvokeLLMToolCall[];
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
