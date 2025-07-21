import * as path from "path";
import { openai } from "@ai-sdk/openai";
import scenario, { AgentInput, AgentRole } from "@langwatch/scenario";
import { CoreMessage } from "ai";
import { describe, it, expect } from "vitest";
import { OpenAiVoiceAgent, saveConversationAudio } from "./helpers";
import { messageRoleReversal } from "../../../src/agents/utils";

/**
 * Audio agent that responds with audio using OpenAI's voice-to-voice model
 */
class MyAgent extends OpenAiVoiceAgent {
  role: AgentRole = AgentRole.AGENT;

  constructor() {
    super({
      systemPrompt: `You are a helpful and engaging AI assistant.
      Respond naturally and conversationally since this is an audio conversation.
      Be informative but keep your responses concise and engaging.
      Adapt your speaking style to be natural for audio.`,
      voice: "echo",
    });
  }
}

/**
 * Custom user simulation agent that generates audio responses
 * for full audio-to-audio conversations
 */
class AudioUserSimulatorAgent extends OpenAiVoiceAgent {
  role: AgentRole = AgentRole.USER;

  constructor() {
    super({
      systemPrompt: `
      You are role playing as a curious user looking for information about AI agentic testing,
      but you're a total novice and don't know anything about it.

      Be natural and conversational in your speech patterns.
      This is an audio conversation, so speak as you would naturally talk.

      After 2 responses from the other speaker, say "I'm done with this conversation" and say goodbye.

      YOUR LANGUAGE IS ENGLISH.
      `,
      voice: "nova",
    });
  }

  public async call(input: AgentInput): Promise<CoreMessage | string> {
    /**
     * We need to reverse the messages roles here so that agent can impersonate the user.
     */
    const messages = messageRoleReversal(input.messages);
    return super.call({
      ...input,
      messages,
    });
  }
}

// Use setId to group together for visualizing in the UI
const setId = "full-audio-conversation-test";

describe("Multimodal Voice-to-Voice Conversation Tests", () => {
  it("should handle complete audio-to-audio conversation", async () => {
    const audioUserSimulator = new AudioUserSimulatorAgent();
    const audioAgent = new MyAgent();

    // Judge that can evaluate audio conversations
    const conversationJudge = scenario.judgeAgent({
      model: openai("gpt-4o-audio-preview"),
      criteria: ["The conversation flows naturally between user and agent"],
    });

    // Run the scenario
    const result = await scenario.run({
      name: "full audio-to-audio conversation",
      description:
        "Complete audio conversation between user simulator and agent over multiple turns",
      agents: [audioAgent, audioUserSimulator, conversationJudge],
      script: [scenario.proceed(6), scenario.judge()],
      setId,
    });

    try {
      console.log("FULL AUDIO CONVERSATION RESULT", result);

      // Save the conversation as an audio file
      const outputPath = path.join(
        process.cwd(),
        "audio_conversations",
        "full-conversation.wav"
      );
      await saveConversationAudio(result, outputPath);

      expect(result.success).toBe(true);
    } catch (error) {
      console.error("Full audio conversation failed:", result);
      throw error;
    }
  });

  // Ideas for future tests
  it.todo("should handle longer audio conversations");
  it.todo("should handle audio conversation with emotional content");
  it.todo("should handle audio conversation with technical topics");
  it.todo("should handle audio conversation interruptions gracefully");
  it.todo("should handle audio conversation with multiple speakers");
});
