import { openai } from "@ai-sdk/openai";
import scenario, { AgentRole } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";
import {
  wrapJudgeForAudio,
  RealtimeScenarioAdapter,
  OpenAiVoiceAgent,
} from "./helpers";

// Group related test runs in the UI
const setId = "realtime-sdk-agent-test";

/**
 * User simulator agent that sends audio messages
 */
class AudioUserSimulatorAgent extends OpenAiVoiceAgent {
  role: AgentRole = AgentRole.USER;

  constructor() {
    super({
      systemPrompt: `
You are role playing as a curious user looking for information about AI agentic testing.
Be natural and conversational in your speech patterns.
After 2 responses from the other speaker, say "I'm done with this conversation" and say goodbye.
YOUR LANGUAGE IS ENGLISH.
`,
      voice: "nova",
    });
  }
}

describe("Realtime SDK Agent Tests", () => {
  it("should handle a conversation with RealtimeScenarioAdapter", async () => {
    const userSimulator = new AudioUserSimulatorAgent();
    const realtimeAgent = new RealtimeScenarioAdapter({
      systemPrompt: `You are a helpful and engaging AI assistant.
Respond naturally and conversationally since this is an audio conversation.
Be informative but keep your responses short, concise and engaging.`,
      voice: "echo",
    });

    const conversationJudge = wrapJudgeForAudio(
      scenario.judgeAgent({
        model: openai("gpt-4o"),
        criteria: ["The conversation flows naturally between user and agent"],
      })
    );

    const result = await scenario.run({
      name: "Realtime SDK conversation test",
      description:
        "Complete audio conversation between user simulator and Realtime SDK agent over multiple turns",
      agents: [realtimeAgent, userSimulator, conversationJudge],
      script: [
        scenario.proceed(2), // Two turns of conversation
        scenario.judge(),
      ],
      setId,
    });

    expect(result.success).toBe(true);
  }, 60000); // Increase timeout for audio processing
});
