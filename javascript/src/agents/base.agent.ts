import { generateText } from "ai";
import { InvokeLLMParams, InvokeLLMResult } from "./types";
import { ScenarioAgent, AgentInput, AgentReturnTypes } from "../domain/agents";
import { Logger } from "../utils/logger";

export abstract class BaseAgent implements ScenarioAgent {
  abstract readonly role: ScenarioAgent["role"];
  logger = new Logger(this.constructor.name);
  abstract call(input: AgentInput): Promise<AgentReturnTypes>;
  /**
   * Invokes the LLM with the given parameters.
   *
   * Override this method to customize the LLM call (e.g., add custom headers,
   * modify messages, use different models, or implement custom logging).
   *
   * @param params Parameters for the LLM invocation
   * @returns The LLM completion result
   */
  protected async invokeLLM(params: InvokeLLMParams): Promise<InvokeLLMResult> {
    try {
      return await generateText(params);
    } catch (error) {
      this.logger.error("Error generating text", { error });
      throw error;
    }
  }
}
