import { LanguageModel } from "ai";

/**
 * Configuration for the inference parameters of a testing agent.
 */
export interface TestingAgentInferenceConfig {
  /**
   * The language model to use for generating responses.
   * If not provided, a default model will be used.
   */
  model?: LanguageModel;
  /**
   * The temperature for the language model.
   * Defaults to 0.
   */
  temperature?: number;
  /**
   * The maximum number of tokens to generate.
   */
  maxTokens?: number;
}

/**
 * General configuration for a testing agent.
 */
export interface TestingAgentConfig extends TestingAgentInferenceConfig {
  /**
   * The name of the agent.
   */
  name?: string;
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
