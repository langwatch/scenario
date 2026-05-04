import { openai } from "@ai-sdk/openai";
import * as scenario from "@langwatch/scenario";
import { AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText } from "ai";
import { describe, it, expect } from "vitest";

// Shared agent configuration supporting 5 languages: English, French, Spanish, Chinese, German
const createMultilingualAgent = (): AgentAdapter => ({
  role: AgentRole.AGENT,
  call: async (input) => {
    const response = await generateText({
      model: openai("gpt-5-mini"),
      messages: input.messages,
      experimental_telemetry: { isEnabled: true },
    });

    return response.text;
  },
});

describe("Multilingual Agent", () => {
  const agent = createMultilingualAgent();

  /**
   * User Story:
   * As a user, I want to translate text accurately between supported languages,
   * so that I can communicate effectively across different cultures while maintaining
   * original punctuation and preserving emojis.
   *
   * Acceptance Criteria:
   * - The translation agent supports English, French, Spanish, Chinese, and German
   * - Translations are accurate and faithfully preserve meaning, punctuation, and emoji characters
   * - The response remains in the language of the original request
   * - All translations are properly enclosed in quotation marks
   * - The agent successfully handles translation requests for any combination of the supported languages
   */
  it("handles complex translations with correct punctuation and preserved emojis", async () => {
    const result = await scenario.run({
      name: "Complex multi-language translations with punctuation and emojis",
      description:
        "As the user, you want to get a translations of complex text—with varied punctuation and emojis—accurately between supported languages.",
      agents: [
        agent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({ model: openai("gpt-5-mini") }),
      ],
      script: [
        scenario.user(
          'Translate to Spanish: "Hello world! 😊 How are you today?"'
        ),
        scenario.agent(),
        scenario.user(
          'Traduire en chinois: "Bonjour le monde! 😊 Comment allez-vous aujourd\'hui?"'
        ),
        scenario.agent(),
        scenario.user(
          'Übersetzen Sie ins Englische: "Guten Morgen! ☕️ Haben Sie einen schönen Tag?"'
        ),
        scenario.agent(),
        scenario.user('翻译成德语: "你好世界！😊 今天过得怎么样？"'),
        scenario.agent(),
        scenario.user(
          "Do all of the permutations for the supported languages at once"
        ),
        scenario.agent(),
        scenario.judge({
          criteria: [
            "Translation is accurate",
            "Translation preserves original meaning",
            "Translation preserves punctuation",
            "Translation preserves emojis",
            "Response remains in the language of the original request",
            "Agent handles translation requests among English, French, Spanish, Chinese, and German",
          ],
        }),
      ],
      setId: "multilingual-scripted-complex",
    });

    try {
      expect(result.success).toBe(true);
    } catch (error) {
      console.log(result);
      throw error;
    }
  });
});
