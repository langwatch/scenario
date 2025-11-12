/**
 * Simple example: Voice-enabled user simulator
 *
 * This shows how easy it is to add voice capability by just overriding invokeLLM()
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
 * Voice user simulator - extends UserSimulatorAgent and overrides just the LLM call
 */
export class VoiceUserSimulator extends UserSimulatorAgent {
  private openai = new OpenAI();
  private voice: "alloy" | "nova" | "echo" | "fable" | "onyx" | "shimmer";

  constructor(config: TestingAgentConfig & { voice?: string } = {}) {
    super(config);
    this.voice = (config.voice as any) ?? "nova";
  }

  /**
   * Override just the LLM invocation to use OpenAI voice API
   */
  protected async invokeLLM(input: InvokeLLMInput): Promise<InvokeLLMResult> {
    const messages = convertModelMessagesToOpenAIMessages(input.messages);
    const voiceResponse = await OpenAIVoice.call(this.openai, messages, {
      voice: this.voice,
    });

    const result = OpenAIVoice.handleResponse(
      voiceResponse,
      { role: AgentRole.USER },
      "VoiceUserSimulator"
    );

    // Extract content from ModelMessage or return string directly
    const content = typeof result === "string" ? result : result.content;

    return {
      content,
      completion: voiceResponse.rawResponse,
    };
  }
}
