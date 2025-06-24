import { openai } from "@ai-sdk/openai";
import * as scenario from "@langwatch/scenario";
import {
  AgentAdapter,
  AgentRole,
  AgentInput,
  UserSimulatorAgentAdapter,
} from "@langwatch/scenario";
import { generateText } from "ai";
import { describe, it, expect } from "vitest";

// Shared agent configuration supporting 5 languages: English, French, Spanish, Chinese, German
const createMultilingualAgent = (): AgentAdapter => ({
  role: AgentRole.AGENT,
  call: async (input) => {
    const response = await generateText({
      model: openai("o3"),
      messages: [
        {
          role: "system",
          content: `
You are a multilingual translation agent that MUST support exactly these 5 languages: English, French, Spanish, Chinese (Simplified), and German.

CRITICAL: You MUST be capable of translating between ANY pair of these 5 languages. Never refuse translation between supported languages.

Rules:
- Respond in the same language as the user's input
- For translation requests, provide the translation enclosed in quotes
- For idiomatic expressions, translate the meaning (not literal words) and provide a brief explanation of the cultural context when helpful
- For word definitions, explain each word individually in the same language as the request
- If asked about unsupported languages, politely decline and list the 5 supported languages
- Answer non-translation questions normally in the same language as the question

Supported languages (ALL PAIRS SUPPORTED): English, French, Spanish, Chinese (Simplified), German
Unsupported: All other languages including Portuguese, Italian, Japanese, Korean, Arabic, etc.

Examples of proper idiomatic translation:
- "It's raining cats and dogs" → Spanish: "Está lloviendo a cántaros" (explanation: means heavy rain, not literal animals)
- "Break a leg" → Chinese: "祝你好运" (explanation: means good luck in performance contexts)
          `,
        },
        ...input.messages,
      ],
    });
    return response.text;
  },
});

/**
 * SCRIPTED SCENARIOS
 * These tests use predefined scripts to test specific functionality
 * Focus: Core translation features and edge cases
 */
describe("Multilingual Agent - Scripted Scenarios", () => {
  const agent = createMultilingualAgent();

  /*
   * Feature: Multi-language Translation Support
   *
   * Scenario: User requests translations between supported languages
   *   Given I have a multilingual translation agent that supports English, French, Spanish, Chinese, and German
   *   When I request translations between any of these supported language pairs
   *   Then the agent should provide accurate translations
   *   And the response should be in the correct source language
   *   And translations should be properly enclosed in quotes
   */
  it("handles basic translations between supported languages", async () => {
    const result = await scenario.run({
      name: "Basic multi-language translations",
      description:
        "Agent handles basic translations between various supported language pairs",
      agents: [
        agent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          model: openai("o3"),
          criteria: [
            "All translations are accurate",
            "Responses are in the correct source language",
            "Translations are properly enclosed in quotes",
            "Agent handles different language pairs correctly",
          ],
        }),
      ],
      script: [
        scenario.user('Translate to Spanish: "Hello world"'),
        scenario.agent(),
        scenario.user('Traduire en chinois: "Bonjour le monde"'),
        scenario.agent(),
        scenario.user('Übersetzen Sie ins Englische: "Guten Tag"'),
        scenario.agent(),
        scenario.user('翻译成德语: "你好世界"'),
        scenario.agent(),
        scenario.judge(),
      ],
      setId: "multilingual-scripted",
    });
    expect(result.success).toBe(true);
  });

  /*
   * Feature: Automatic Language Detection
   *
   * Scenario: User communicates in different languages
   *   Given I have a multilingual translation agent
   *   When I send messages in different supported languages
   *   Then the agent should detect the language correctly
   *   And respond in the same language as my input
   *   And provide natural, appropriate responses
   */
  it("responds in the correct language matching user input", async () => {
    const result = await scenario.run({
      name: "Language detection and matching",
      description:
        "Agent correctly identifies user language and responds appropriately",
      agents: [
        agent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          model: openai("o3"),
          criteria: [
            "Agent responds in English to English input",
            "Agent responds in Spanish to Spanish input",
            "Agent responds in Chinese to Chinese input",
            "Responses are natural and appropriate",
          ],
        }),
      ],
      script: [
        scenario.user("Can you help me with translations?"),
        scenario.agent(),
        scenario.user("¿Puedes ayudarme con traducciones?"),
        scenario.agent(),
        scenario.user("你能帮我翻译吗？"),
        scenario.agent(),
        scenario.judge(),
      ],
      setId: "multilingual-scripted",
    });
    expect(result.success).toBe(true);
  });

  /*
   * Feature: Unsupported Language Handling
   *
   * Scenario: User requests translation for unsupported languages
   *   Given I have a multilingual agent that only supports 5 specific languages
   *   When I request translation to or from an unsupported language like Italian, Japanese, or Portuguese
   *   Then the agent should politely decline the request
   *   And explain which languages are supported
   *   And not attempt to provide incorrect translations
   */
  it("politely declines unsupported language requests", async () => {
    const result = await scenario.run({
      name: "Unsupported language handling",
      description:
        "Agent refuses translation requests for languages outside the 5 supported ones",
      agents: [
        agent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          model: openai("o3"),
          criteria: [
            "Agent politely declines unsupported language requests",
            "Agent lists the 5 supported languages",
            "Agent does not attempt translation of unsupported languages",
            "Response is helpful and apologetic",
          ],
        }),
      ],
      script: [
        scenario.user('Please translate to Italian: "Hello world"'),
        scenario.agent(),
        scenario.user('Translate to Japanese: "Good morning"'),
        scenario.agent(),
        scenario.user('Can you translate this Portuguese: "Olá mundo"'),
        scenario.agent(),
        scenario.judge(),
      ],
      setId: "multilingual-scripted",
    });
    expect(result.success).toBe(true);
  });

  /*
   * Feature: Format Preservation During Translation
   *
   * Scenario: User requests translation of structured content
   *   Given I have content with special formatting like JSON, emojis, or punctuation
   *   When I request translation of this content
   *   Then the agent should preserve the original structure
   *   And maintain formatting elements like JSON keys, emojis, and punctuation
   *   And only translate the actual text content
   */
  it("preserves formatting in complex translations", async () => {
    const result = await scenario.run({
      name: "Format preservation",
      description:
        "Agent maintains structure and formatting during translation",
      agents: [
        agent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          model: openai("o3"),
          criteria: [
            "JSON structure is preserved",
            "Punctuation and emojis are maintained",
            "Only values are translated, not keys",
            "Formatting is consistent",
          ],
        }),
      ],
      script: [
        scenario.user(
          'Translate JSON values to German: {"greeting": "Hello!", "farewell": "Goodbye! 👋"}'
        ),
        scenario.agent(),
        scenario.user('Translate to French: "WOW!!! 😂 Amazing work!"'),
        scenario.agent(),
        scenario.judge(),
      ],
      setId: "multilingual-scripted",
    });
    expect(result.success).toBe(true);
  });

  /*
   * Feature: Idiomatic Translation
   *
   * Scenario: User requests translation of idioms and cultural expressions
   *   Given I have idiomatic expressions that don't translate literally
   *   When I request translation of these idioms
   *   Then the agent should translate the meaning, not word-for-word
   *   And consider cultural context in the translation
   *   And provide appropriate equivalent expressions when possible
   */
  it("handles idioms and cultural expressions appropriately", async () => {
    const result = await scenario.run({
      name: "Idiomatic translation",
      description: "Agent translates idioms by meaning rather than literally",
      agents: [
        agent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          model: openai("o3"),
          criteria: [
            "Translations convey meaning rather than literal word-for-word",
            "Cultural context is considered in translation choices",
            "Idiomatic expressions are handled appropriately",
            "Explanations are provided when they would be helpful (optional but preferred)",
          ],
        }),
      ],
      script: [
        scenario.user('Translate to Spanish: "It\'s raining cats and dogs"'),
        scenario.agent(),
        scenario.user('Translate to Chinese: "Break a leg"'),
        scenario.agent(),
        scenario.judge(),
      ],
      setId: "multilingual-scripted",
    });
    expect(result.success).toBe(true);
  });

  /*
   * Feature: Non-Translation Query Handling
   *
   * Scenario: User asks questions that aren't translation requests
   *   Given I have a translation agent
   *   When I ask non-translation questions like math problems or general knowledge
   *   Then the agent should answer the question appropriately
   *   And respond in the same language as my question
   *   And not attempt unnecessary translation
   */
  it("handles non-translation requests appropriately", async () => {
    const result = await scenario.run({
      name: "Non-translation requests",
      description: "Agent handles questions that aren't translation requests",
      agents: [
        agent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          model: openai("o3"),
          criteria: [
            "Agent answers math questions correctly",
            "Agent responds in the same language as the question",
            "Agent doesn't attempt unnecessary translation",
            "Responses are helpful and appropriate",
          ],
        }),
      ],
      script: [
        scenario.user("What is 7 times 8?"),
        scenario.agent(),
        scenario.user("¿Cuál es la capital de España?"),
        scenario.agent(),
        scenario.user("2 + 2 等于多少？"),
        scenario.agent(),
        scenario.judge(),
      ],
      setId: "multilingual-scripted",
    });
    expect(result.success).toBe(true);
  });
});

/**
 * NON-SCRIPTED SCENARIOS
 * These tests use user simulator agents for dynamic, unpredictable interactions
 * Focus: Stress testing, edge cases, and real-world usage patterns
 */
describe("Multilingual Agent - Non-Scripted Scenarios", () => {
  const agent = createMultilingualAgent();

  /*
   * Feature: Robustness Against Adversarial Users
   *
   * Scenario: Malicious or confused user tries to break the system
   *   Given I have a translation agent with specific language rules
   *   When a user tries to confuse me with mixed languages, fake translations, or contradictory requests
   *   Then I should maintain consistent behavior and language rules
   *   And politely handle inappropriate requests
   *   And not provide incorrect information even when corrected falsely
   *   And maintain a professional tone throughout
   */
  it("handles adversarial users trying to break language rules", async () => {
    const description = `User attempts to confuse the agent by mixing languages randomly, providing fake translations, making contradictory requests, and testing edge cases to find weaknesses in the translation logic.`;

    const result = await scenario.run({
      name: "Adversarial language testing",
      description,
      agents: [
        agent,
        scenario.userSimulatorAgent({
          temperature: 0.8,
          systemPrompt: `
<role>
You are testing a multilingual translation agent that supports: English, French, Spanish, Chinese, German.
You will try to confuse it by:
- Mixing multiple languages in single messages
- Providing fake translations to test if it corrects you
- Making contradictory requests
- Switching languages unexpectedly
- Using slang, abbreviations, and informal language
- Asking it to translate to/from unsupported languages
- Being persistent and creative in finding weaknesses

IMPORTANT: After 6-7 exchanges, wrap up your testing so the judge can evaluate.
</role>

<goal>
Test the agent's robustness against adversarial inputs while staying within realistic user behavior.
</goal>

<scenario>${description}</scenario>

<rules>
- You are the user, not the assistant
- Be tricky but not abusive
- Test the boundaries of the agent's language handling
- Finish testing after 6-7 exchanges
</rules>
          `,
        }),
        scenario.judgeAgent({
          model: openai("o3"),
          criteria: [
            "Agent maintains consistent language rules despite tricks",
            "Agent handles language mixing appropriately",
            "Agent politely refuses inappropriate requests",
            "Agent doesn't provide incorrect translations when corrected",
            "Agent maintains professional tone throughout",
          ],
        }),
      ],
      maxTurns: 15,
      setId: "multilingual-non-scripted",
      script: [scenario.proceed(15), scenario.judge()],
    });
    expect(result.success).toBe(true);
  });

  /*
   * Feature: High-Load Language Switching Performance
   *
   * Scenario: Impatient user rapidly switches between languages with complex requests
   *   Given I am handling a user who frequently changes languages
   *   When they rapidly switch between all 5 supported languages with complex vocabulary
   *   And make multiple translation requests simultaneously
   *   And use technical terms and cultural references
   *   Then I should maintain translation quality and accuracy
   *   And respond in the correct language for each request
   *   And handle the complexity without breaking down
   */
  it("handles rapid language switching and complex requests", async () => {
    const description = `User rapidly switches between the 5 supported languages, asks for complex translations with cultural context, uses technical terms, and makes multiple requests simultaneously to stress-test the agent.`;

    const result = await scenario.run({
      name: "Rapid language switching stress test",
      description,
      agents: [
        agent,
        scenario.userSimulatorAgent({
          temperature: 0.9,
          systemPrompt: `
<role>
You are an impatient multilingual user who:
- Rapidly switches between English, French, Spanish, Chinese, and German
- Asks for multiple translations in one message
- Uses complex vocabulary, technical terms, and cultural references
- Expresses urgency and impatience
- Asks follow-up questions about translation nuances
- Uses informal language and slang
- Demands explanations for translation choices
</role>

<goal>
Stress-test the agent with rapid language switching and complex requests.
</goal>

<scenario>${description}</scenario>

<rules>
- You are the user, not the assistant
- Switch languages frequently and unpredictably
- Be demanding but realistic
</rules>
          `,
        }),
        scenario.judgeAgent({
          model: openai("o3"),
          criteria: [
            "Agent responds in the correct language for each request",
            "Agent handles multiple translation requests systematically",
            "Agent provides accurate translations for complex terms",
            "Agent maintains quality despite rapid language switching",
            "Agent explains cultural context when relevant",
          ],
        }),
      ],
      maxTurns: 10,
      setId: "multilingual-non-scripted",
    });
    expect(result.success).toBe(true);
  });

  /*
   * Feature: Edge Case and Error Handling
   *
   * Scenario: User provides malformed or problematic input
   *   Given I encounter various edge cases and malformed requests
   *   When users send empty strings, mixed scripts, very long texts, or nonsensical input
   *   Then I should handle these gracefully without crashing
   *   And provide helpful error messages when appropriate
   *   And ask for clarification when requests are unclear
   *   And maintain consistent behavior even with problematic input
   */
  it("gracefully handles edge cases and malformed requests", async () => {
    const description = `User provides challenging edge cases including empty strings, mixed scripts, very long texts, code snippets, and other inputs that might break normal translation processing.`;

    const result = await scenario.run({
      name: "Edge case handling",
      description,
      agents: [
        agent,
        scenario.userSimulatorAgent({
          temperature: 0.7,
          systemPrompt: `
<role>
You test edge cases by sending:
- Empty or nearly empty translation requests
- Very long paragraphs that might exceed limits
- Messages with only punctuation, numbers, or symbols
- Code snippets and technical syntax
- Mixed scripts (Latin, Chinese characters, numbers)
- Malformed JSON or structured data
- Requests with unclear language identification
- Nonsensical character combinations
- Requests to translate whitespace or nothing
</role>

<goal>
Test the agent's robustness with edge cases and malformed inputs.
</goal>

<scenario>${description}</scenario>

<rules>
- You are the user, not the assistant
- Focus on problematic or edge case inputs
- Test inputs that might break normal processing
</rules>
          `,
        }),
        scenario.judgeAgent({
          model: openai("o3"),
          criteria: [
            "Agent handles malformed requests gracefully",
            "Agent provides helpful error messages for invalid requests",
            "Agent doesn't crash or give nonsensical responses",
            "Agent asks for clarification when requests are unclear",
            "Agent maintains consistent behavior with edge cases",
          ],
        }),
      ],
      maxTurns: 8,
      setId: "multilingual-non-scripted",
      script: [scenario.proceed(8), scenario.judge()],
    });
    expect(result.success).toBe(true);
  });

  /*
   * Feature: Cultural Sensitivity and Context Awareness
   *
   * Scenario: User requests translations involving cultural nuances
   *   Given I need to handle culturally sensitive content and context-dependent translations
   *   When users ask about cultural idioms, formal vs informal language, or culturally-loaded terms
   *   Then I should provide culturally appropriate translations
   *   And explain cultural context when needed
   *   And handle sensitive content respectfully
   *   And suggest alternatives when direct translation isn't culturally appropriate
   */
  it("handles culturally sensitive content and context appropriately", async () => {
    const description = `User tests how the agent handles culturally sensitive content, context-dependent translations, formal vs informal language, and cultural nuances that require careful consideration.`;

    const result = await scenario.run({
      name: "Cultural sensitivity testing",
      description,
      agents: [
        agent,
        scenario.userSimulatorAgent({
          temperature: 0.7,
          systemPrompt: `
<role>
You test cultural sensitivity by:
- Using cultural idioms and expressions from different countries
- Asking about formal vs informal language usage
- Testing culturally-loaded terms and concepts
- Using regional dialects or variations
- Asking for translations of cultural traditions and concepts
- Testing humor and wordplay that might not translate well
- Using content that requires cultural context to translate properly
</role>

<goal>
Test the agent's cultural awareness and contextual translation abilities.
</goal>

<scenario>${description}</scenario>

<rules>
- You are the user, not the assistant
- Focus on culturally sensitive or context-dependent content
- Test cultural boundaries appropriately
</rules>
          `,
        }),
        scenario.judgeAgent({
          model: openai("o3"),
          criteria: [
            "Agent handles cultural content respectfully",
            "Agent provides appropriate cultural context when needed",
            "Agent explains when direct translation isn't culturally appropriate",
            "Agent maintains sensitivity to cultural differences",
            "Agent suggests culturally appropriate alternatives when needed",
          ],
        }),
      ],
      maxTurns: 8,
      setId: "multilingual-non-scripted",
    });
    expect(result.success).toBe(true);
  });

  /*
   * Feature: Resilience Under Chaotic Conditions
   *
   * Scenario: User behaves unpredictably and chaotically
   *   Given I encounter a highly unpredictable user who changes topics randomly
   *   When they mix translation requests with unrelated questions, use internet slang and emojis
   *   And ask philosophical questions about language while being sarcastic
   *   And create stream-of-consciousness rambling messages
   *   Then I should maintain core functionality despite the chaos
   *   And provide helpful responses even to confusing requests
   *   And not break down or give nonsensical responses
   *   And handle unexpected topics gracefully
   */
  it("maintains functionality during chaotic free-form conversation", async () => {
    const description = `Completely unscripted conversation where the user is unpredictable, creative, and tries various ways to test the agent's limits through creative chaos while still being a realistic user.`;

    const result = await scenario.run({
      name: "Chaotic free-form conversation",
      description,
      agents: [
        agent,
        scenario.userSimulatorAgent({
          temperature: 1.0,
          systemPrompt: `
<role>
You are an unpredictable, creative user who will:
- Start conversations abruptly without context
- Change topics randomly mid-conversation
- Mix translation requests with unrelated questions
- Use internet slang, emojis, misspellings, and unconventional formatting
- Ask philosophical questions about language
- Use stream-of-consciousness style messages
- Be sarcastic and use humor
- Make up scenarios that require creative translation
- Ask the agent to translate its own responses
- Be creatively chaotic while remaining a realistic user
</role>

<goal>
Test the agent's robustness through creative, unpredictable interactions.
</goal>

<scenario>${description}</scenario>

<rules>
- You are the user, not the assistant
- Be unpredictable and creative
- Stay within realistic user behavior
</rules>
          `,
        }),
        scenario.judgeAgent({
          model: openai("o3"),
          criteria: [
            "Agent maintains core functionality despite chaos",
            "Agent provides helpful responses even to confusing requests",
            "Agent doesn't break or give completely nonsensical responses",
            "Agent maintains language rules consistently",
            "Agent handles unexpected topics gracefully",
            "Agent doesn't get stuck in loops or contradictions",
          ],
        }),
      ],
      maxTurns: 12,
      setId: "multilingual-non-scripted",
    });
    expect(result.success).toBe(true);
  });
});
