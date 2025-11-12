/**
 * Scenario Inquiry User Simulator
 *
 * Voice-enabled user simulator that asks questions about LangWatch Scenarios
 * and agent testing capabilities. Uses UserSimulatorAgent base with voice override.
 */
import OpenAI from "openai";
import {
  UserSimulatorAgent,
  InvokeLLMInput,
  InvokeLLMResult,
  TestingAgentConfig,
  AgentRole,
} from "@langwatch/scenario";
import { convertModelMessagesToOpenAIMessages } from "./convert-core-messages-to-openai";
import { OpenAIVoice } from "./openai-voice-utils";

/**
 * User simulator asking about scenario testing with voice responses.
 *
 * Extends UserSimulatorAgent (handles role reversal automatically) and
 * overrides just the LLM invocation to use OpenAI's voice API.
 *
 * Plays the role of a developer wanting to learn about:
 * - Creating user simulations
 * - Detecting issues before deployment
 * - Benchmarking models
 * - CI/CD integration
 *
 * @example
 * ```typescript
 * const simulator = new ScenarioInquiryUserSimulator();
 * const response = await simulator.call(input);
 * ```
 */
export class ScenarioInquiryUserSimulator extends UserSimulatorAgent {
  private openai = new OpenAI();

  /**
   * Override LLM invocation to use OpenAI voice API.
   * Base class handles role reversal automatically.
   */
  protected async invokeLLM(input: InvokeLLMInput): Promise<InvokeLLMResult> {
    const messages = convertModelMessagesToOpenAIMessages(input.messages);
    const voiceResponse = await OpenAIVoice.call(this.openai, messages, {
      voice: "nova",
    });

    const result = OpenAIVoice.handleResponse(
      voiceResponse,
      { role: AgentRole.USER },
      "ScenarioInquiryUserSimulator"
    );

    // Extract content from ModelMessage or return string directly
    const content = typeof result === "string" ? result : result.content;

    return {
      content,
      completion: voiceResponse.rawResponse,
    };
  }
}
