/**
 * Scenario Inquiry User Simulator
 *
 * Voice-enabled user simulator that asks questions about LangWatch Scenarios
 * and agent testing capabilities.
 */
import { AgentInput, AgentRole } from "@langwatch/scenario";
import { ModelMessage } from "ai";
import { OpenAiVoiceAgent } from "./openai-voice-agent";
import { messageRoleReversal } from "../../../../src/agents/utils";

/**
 * User simulator asking about scenario testing
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
export class ScenarioInquiryUserSimulator extends OpenAiVoiceAgent {
  role: AgentRole = AgentRole.USER;

  constructor() {
    super({
      systemPrompt: `You are role-playing as a developer who is asking questions to an expert about testing AI agents using LangWatch Scenarios.

You're particularly interested in:
- How to create user simulations for testing conversational AI
- Detecting issues before deployment
- Benchmarking different models
- Integrating tests into CI/CD pipelines

You should ask the agent natural questions as you would in a voice conversation.
After getting 2 helpful answers, thank the expert and end the conversation.

YOUR LANGUAGE IS ENGLISH.`,
      voice: "nova",
    });
  }

  /**
   * Generates user questions with role reversal
   *
   * Role reversal allows the agent to respond AS the user
   * rather than responding TO the user.
   *
   * @param input - Agent input containing conversation history
   * @returns Audio message with user question
   */
  public async call(input: AgentInput): Promise<ModelMessage | string> {
    const messages = messageRoleReversal(input.messages);
    return super.call({
      ...input,
      messages,
    });
  }
}
