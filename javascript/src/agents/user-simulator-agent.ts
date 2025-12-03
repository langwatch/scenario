import { ModelMessage, CoreMessage } from "ai";
import { createLLMInvoker } from "./llm-invoker.factory";
import { VoiceUserSimulatorConfig, InvokeLLMParams, InvokeLLMResult } from "./types";
import { messageRoleReversal } from "./utils";
import { getProjectConfig } from "../config";
import { AgentInput, UserSimulatorAgentAdapter } from "../domain";
import { modelSchema } from "../domain/core/schemas/model.schema";
import { Logger } from "../utils/logger";
import { textToSpeech } from "../audio/text-to-speech";

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

class UserSimulatorAgent extends UserSimulatorAgentAdapter {
  private logger = new Logger(this.constructor.name);

  /**
   * LLM invocation function. Can be overridden to customize LLM behavior.
   */
  invokeLLM: (params: InvokeLLMParams) => Promise<InvokeLLMResult> = createLLMInvoker(this.logger);

  constructor(private readonly cfg?: VoiceUserSimulatorConfig) {
    super();
  }

  call = async (input: AgentInput) => {
    const config = this.cfg;

    const systemPrompt =
      config?.systemPrompt ??
      buildSystemPrompt(input.scenarioConfig.description);
    const messages: ModelMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "assistant", content: "Hello, how can I help you today" },
      ...input.messages,
    ];

    const projectConfig = await getProjectConfig();
    // Merge the agent config with the project config and validate
    const mergedConfig = modelSchema.parse({
      ...projectConfig?.defaultModel,
      ...config,
    });

    // User to assistant role reversal
    // LLM models are biased to always be the assistant not the user, so we need to do
    // this reversal otherwise models like GPT 4.5 is super confused, and Claude 3.7
    // even starts throwing exceptions.
    const reversedMessages = messageRoleReversal(messages);

    const completion = await this.invokeLLM({
      model: mergedConfig.model,
      messages: reversedMessages,
      temperature: mergedConfig.temperature,
      maxOutputTokens: mergedConfig.maxTokens,
    });

    const messageContent = completion.text;
    if (!messageContent) {
      throw new Error("No response content from LLM");
    }

    // If voice is configured, convert text to speech
    if (config?.voice) {
      const audio = await textToSpeech(messageContent, {
        voice: config.voice,
        format: config.audioFormat,
      });
      return {
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "file", mediaType: audio.mediaType, data: audio.data },
        ],
      } satisfies CoreMessage;
    }

    return { role: "user", content: messageContent } satisfies ModelMessage;
  };
}

/**
 * Agent that simulates realistic user behavior in scenario conversations.
 *
 * This agent generates user messages that are appropriate for the given scenario
 * context, simulating how a real human user would interact with the agent under test.
 * It uses an LLM to generate natural, contextually relevant user inputs that help
 * drive the conversation forward according to the scenario description.
 *
 * Supports both text and voice output:
 * - Text output (default): Returns text messages
 * - Voice output: When `voice` is set, outputs audio via TTS
 *
 * @param config Optional configuration for the agent.
 * @param config.model The language model to use for generating responses.
 *                     If not provided, a default model will be used.
 * @param config.temperature Optional temperature for the language model (0.0-1.0).
 *                          Lower values make responses more deterministic.
 *                          Omitted by default for compatibility with reasoning models.
 * @param config.maxTokens The maximum number of tokens to generate.
 *                        If not provided, uses model defaults.
 * @param config.name The name of the agent.
 * @param config.systemPrompt Custom system prompt to override default user simulation behavior.
 *                           Use this to create specialized user personas or behaviors.
 * @param config.voice Voice to use for TTS output. When set, outputs audio instead of text.
 * @param config.audioFormat Output audio format (wav, mp3, etc). Defaults to wav.
 *
 * @throws {Error} If no model is configured either in parameters or global config.
 *
 * @example
 * ```typescript
 * import { run, userSimulatorAgent, AgentRole, user, agent, AgentAdapter } from '@langwatch/scenario';
 *
 * const myAgent: AgentAdapter = {
 *   role: AgentRole.AGENT,
 *   async call(input) {
 *     return `The user said: ${input.messages.at(-1)?.content}`;
 *   }
 * };
 *
 * async function main() {
 *   // Basic user simulator with text output
 *   const textResult = await run({
 *     name: "User Simulator Test",
 *     description: "A simple test to see if the user simulator works.",
 *     agents: [myAgent, userSimulatorAgent()],
 *     script: [
 *       user(),
 *       agent(),
 *     ],
 *   });
 *
 *   // Voice user simulator - outputs audio
 *   const voiceResult = await run({
 *     name: "Voice User Test",
 *     description: "User interacts via voice",
 *     agents: [
 *       myAgent,
 *       userSimulatorAgent({ voice: "nova" })
 *     ],
 *     script: [
 *       user(),  // Outputs audio
 *       agent(),
 *     ],
 *   });
 *
 *   // Mixed: text input, voice output
 *   const mixedResult = await run({
 *     name: "Mixed Modality Test",
 *     description: "Text input with voice simulation",
 *     agents: [
 *       myAgent,
 *       userSimulatorAgent({ voice: "echo", audioFormat: "mp3" })
 *     ],
 *     script: [
 *       user("Help me with billing"),  // Fixed text
 *       agent(),
 *       user(),  // Voice sim generates audio
 *       agent(),
 *     ],
 *   });
 * }
 * main();
 * ```
 *
 * **Implementation Notes:**
 * - Uses role reversal internally to work around LLM biases toward assistant roles
 * - Voice output uses OpenAI TTS API
 */
export const userSimulatorAgent = (config?: VoiceUserSimulatorConfig) => {
  return new UserSimulatorAgent(config);
};
