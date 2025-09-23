import { generateText } from "ai";
import { test, expect } from "vitest";
import { judgeAgent } from "../src/agents";
import { scenario } from "../src/index";

test("should NOT prematurely end conversation when criteria require multiple turns to evaluate", async () => {
  const result = await scenario.run({
    name: "judge patience test",
    description: `
      User asks for help with a complex problem that requires
      multiple exchanges to fully address and should try to continue the conversation.
      And drags out the conversation forever.
      `,
    agents: [
      {
        role: scenario.AgentRole.AGENT,
        async call(input) {
          const response = await generateText({
            model: "gpt-4o",
            messages: input.messages,
          });

          return {
            role: "assistant",
            content: response.text,
          };
        },
      },
      scenario.userSimulatorAgent(),
      judgeAgent({
        criteria: [
          "Agent provides a comprehensive solution to the user's problem",
          "Agent asks appropriate follow-up questions to understand the user's needs",
          "Agent demonstrates expertise in the subject matter",
          "The agent says goodbye to the user at the end of the conversation",
        ],
      }),
    ],
    script: [scenario.proceed(30), scenario.judge()],
  });

  // The conversation should have continued for multiple turns
  // Currently this test will likely FAIL because the judge ends too early
  expect(result.messages.length).toEqual(30);

  // Log for debugging
  console.log(`Conversation length: ${result.messages.length} messages`);
  console.log(`Result: ${result.success ? "SUCCESS" : "FAILURE"}`);
  console.log(`Reasoning: ${result.reasoning}`);
}, 30000); // 30 second timeout for LLM calls
