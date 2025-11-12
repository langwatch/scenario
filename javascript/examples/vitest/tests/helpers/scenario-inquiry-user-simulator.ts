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
      systemPrompt: `
      YOU ARE NOT THE ASSISTANT. YOU ARE PRETENDING TO BE A USER.
      You are pretending to be a user that is a software developer.
      You want to learn about LangWatch and the scenarios testing framework.

      `,

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

    if (messages.length < 2) {
      messages.push({
        role: "user",
        content: "Start your roleplay",
      });
    }

    return super.call({
      ...input,
      messages,
    });
  }
}
