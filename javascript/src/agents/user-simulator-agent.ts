import { generateText, CoreMessage } from "ai";
import { TestingAgentConfig, InvokeLLMInput, InvokeLLMResult } from "./types";
import { messageRoleReversal } from "./utils";
import { getProjectConfig } from "../config";
import { AgentInput, AgentRole, AgentReturnTypes } from "../domain";
import type { IUserSimulatorAgent } from "../domain/agents";
import { modelSchema } from "../domain/core/schemas/model.schema";
import { Logger } from "../utils/logger";

function buildSystemPrompt(description: string): string {
  return `
<role>
You are pretending to be a user, you are testing an AI Agent (shown as the user role) based on a scenario.
Approach this naturally, as a human user would, with very short inputs, few words, all lowercase, imperative, not periods, like when they google or talk to chatgpt.
</role>

<goal>
Your goal (assistant) is to interact with the Agent Under Test (user) as if you were a human user to see if it can complete the scenario successfully.
</goal>

<scenario>
${description}
</scenario>

<rules>
- DO NOT carry over any requests yourself, YOU ARE NOT the assistant today, you are the user
</rules>
`.trim();
}

/**
 * Base user simulator agent with extensible LLM invocation.
 *
 * This class handles all orchestration logic (system prompts, role reversal, config merging).
 * To customize the LLM provider, override the `invokeLLM()` method.
 *
 * **DO NOT OVERRIDE `call()`** - Override `invokeLLM()` instead.
 *
 * @example
 * ```typescript
 * // Use OpenAI voice API
 * class VoiceSimulator extends UserSimulatorAgent {
 *   private openai = new OpenAI();
 *
 *   protected async invokeLLM(input: InvokeLLMInput) {
 *     const response = await this.openai.chat.completions.create({
 *       model: "gpt-4o-audio-preview",
 *       messages: input.messages,
 *       audio: { voice: "nova", format: "wav" },
 *       modalities: ["text", "audio"],
 *     });
 *
 *     const audioData = response.choices[0].message?.audio?.data;
 *     return [
 *       { type: "text", text: "" },
 *       { type: "file", mediaType: "audio/wav", data: audioData }
 *     ];
 *   }
 * }
 *
 * // Use custom LLM provider
 * class CustomSimulator extends UserSimulatorAgent {
 *   protected async invokeLLM(input: InvokeLLMInput) {
 *     const response = await myCustomLLM.generate({
 *       model: input.model,
 *       messages: input.messages,
 *     });
 *     return response.text;
 *   }
 * }
 * ```
 */
export class UserSimulatorAgent implements IUserSimulatorAgent {
  readonly role = AgentRole.USER;
  private logger = new Logger(this.constructor.name);

  constructor(private readonly cfg?: TestingAgentConfig) {}

  /**
   * Main orchestration - DO NOT OVERRIDE.
   * Override `invokeLLM()` to customize LLM provider.
   */
  async call(input: AgentInput): Promise<AgentReturnTypes> {
    try {
      // 1. Build messages with system prompt
      const systemPrompt = this.getSystemPrompt(input);
      const messages: CoreMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "assistant", content: "Hello, how can I help you today" },
        ...input.messages,
      ];

      // 2. Apply role reversal
      // LLM models are biased to always be the assistant not the user, so we need to do
      // this reversal otherwise models like GPT 4.5 is super confused, and Claude 3.7
      // even starts throwing exceptions.
      const reversedMessages = messageRoleReversal(messages);

      // 3. Get model config
      const config = await this.getModelConfig();

      // 4. Prepare LLM input - everything is ready
      const llmInput: InvokeLLMInput = {
        messages: reversedMessages,
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      };

      // 5. Invoke LLM - PURE API CALL (override this method to customize)
      const result = await this.invokeLLM(llmInput);

      // 6. Return formatted response
      return { role: "user", content: result.content } as CoreMessage;
    } catch (error) {
      this.logger.error("Error in user simulator", { error });
      throw error;
    }
  }

  /**
   * EXTENSION POINT - Override this to use different LLM providers.
   *
   * This method receives fully prepared input and should make a pure LLM API call.
   * All orchestration logic (system prompts, role reversal, config) is already done.
   *
   * Returns an object with both content and raw completion, allowing subclasses
   * to access additional data from the LLM response if needed.
   *
   * @param input - Fully prepared LLM input
   * @returns Result containing content and optional raw completion
   */
  protected async invokeLLM(input: InvokeLLMInput): Promise<InvokeLLMResult> {
    // Default: Vercel AI SDK
    const completion = await generateText({
      model: input.model,
      messages: input.messages,
      temperature: input.temperature,
      maxOutputTokens: input.maxTokens,
    });

    if (!completion.text) {
      throw new Error("No response content from LLM");
    }

    return {
      content: completion.text,
      completion, // Provide raw completion for extensibility
    };
  }

  // All helpers are PRIVATE - internal implementation details

  private getSystemPrompt(input: AgentInput): string {
    return (
      this.cfg?.systemPrompt ??
      buildSystemPrompt(input.scenarioConfig.description)
    );
  }

  private async getModelConfig() {
    const projectConfig = await getProjectConfig();
    return modelSchema.parse({
      ...projectConfig?.defaultModel,
      ...this.cfg,
    });
  }
}

/**
 * Factory function for creating user simulator agents.
 *
 * Creates an agent that simulates realistic user behavior in scenario conversations.
 * The agent generates user messages that are appropriate for the given scenario
 * context, simulating how a real human user would interact with the agent under test.
 *
 * @param config Optional configuration for the agent.
 * @param config.model The language model to use for generating responses.
 * @param config.temperature The temperature for the language model (0.0-1.0).
 * @param config.maxTokens The maximum number of tokens to generate.
 * @param config.name The name of the agent.
 * @param config.systemPrompt Custom system prompt to override default user simulation behavior.
 *
 * @returns IUserSimulatorAgent instance
 *
 * @example
 * ```typescript
 * import { run, userSimulatorAgent, AgentRole, user, agent, IAgent } from '@langwatch/scenario';
 *
 * // Basic user simulator
 * const simulator = userSimulatorAgent();
 *
 * // Customized user simulator
 * const customSimulator = userSimulatorAgent({
 *   model: "gpt-4",
 *   temperature: 0.3,
 *   systemPrompt: "You are a technical user who asks detailed questions"
 * });
 *
 * // Use in scenario
 * await run({
 *   name: "Test",
 *   description: "Testing user simulation",
 *   agents: [myAgent, customSimulator],
 *   script: [user(), agent()],
 * });
 * ```
 *
 * **Extending with custom LLM:**
 * ```typescript
 * class VoiceSimulator extends UserSimulatorAgent {
 *   protected async invokeLLM(input: InvokeLLMInput) {
 *     // Use OpenAI voice API
 *     const response = await openai.chat.completions.create({
 *       model: "gpt-4o-audio-preview",
 *       messages: input.messages,
 *       audio: { voice: "nova", format: "wav" },
 *     });
 *     return extractAudio(response);
 *   }
 * }
 * ```
 */
export const userSimulatorAgent = (
  config?: TestingAgentConfig
): IUserSimulatorAgent => {
  return new UserSimulatorAgent(config);
};
