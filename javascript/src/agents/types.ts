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
