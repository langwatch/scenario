import { generateText, CoreMessage } from "ai";
import { AgentInput, AgentRole, UserSimulatorAgentAdapter } from "../domain";
import { TestingAgentConfig } from "./types";
import { messageRoleReversal } from "./utils";
import { getProjectConfig } from "../config";
import { mergeAndValidateConfig } from "../utils/config";

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

export const userSimulatorAgent = (config?: TestingAgentConfig) => {
  return {
    role: AgentRole.USER,

    call: async (input: AgentInput) => {
      const systemPrompt = buildSystemPrompt(input.scenarioConfig.description);
      const messages: CoreMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "assistant", content: "Hello, how can I help you today" },
        ...input.messages,
      ];

      const projectConfig = await getProjectConfig();
      const mergedConfig = mergeAndValidateConfig(config ?? {}, projectConfig);
      if (!mergedConfig.model) {
        throw new Error("Model is required for the user simulator agent");
      }

      // User to assistant role reversal
      // LLM models are biased to always be the assistant not the user, so we need to do
      // this reversal otherwise models like GPT 4.5 is super confused, and Claude 3.7
      // even starts throwing exceptions.
      const reversedMessages = messageRoleReversal(messages);

      const completion = await generateText({
        model: mergedConfig.model,
        messages: reversedMessages,
        temperature: mergedConfig.temperature ?? 0.0,
        maxTokens: mergedConfig.maxTokens,
      });

      const messageContent = completion.text;
      if (!messageContent) {
        throw new Error("No response content from LLM");
      }

      return { role: "user", content: messageContent } satisfies CoreMessage;
    },
  } satisfies UserSimulatorAgentAdapter;
};
