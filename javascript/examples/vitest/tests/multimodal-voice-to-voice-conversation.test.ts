/**
 * Multimodal Voice-to-Voice Conversation Tests
 *
 * This test suite demonstrates a complete audio-to-audio conversation flow where:
 * - A user simulator agent generates audio questions
 * - A main agent responds with audio answers
 * - Both communicate entirely through voice (no text)
 * - The conversation is judged for quality
 * - The full audio is saved for review
 *
 * This showcases:
 * - Custom agent implementations with voice capabilities
 * - Multi-turn voice conversations
 * - Audio message handling and persistence
 * - Judge agent integration with audio transcription
 * - Role reversal for user simulation
 */
import * as path from "path";
import { openai } from "@ai-sdk/openai";
import scenario, { AgentInput, AgentRole } from "@langwatch/scenario";
import { ModelMessage } from "ai";
import { describe, it, expect } from "vitest";
import {
  OpenAiVoiceAgent,
  saveConversationAudio,
  wrapJudgeForAudioTranscription,
} from "./helpers";
import { messageRoleReversal } from "../../../src/agents/utils";

// Skipped in CI: depends on the OpenAI `gpt-4o-audio-preview` model, which
// returns 404 model_not_found as of 2026-05-19. Tracked separately — the
// voice work PR will unskip these tests once model access is restored.
const skipInCi = process.env.CI === "true";

/**
 * Main agent that responds with helpful audio answers
 * Uses "echo" voice for a distinct sound
 */
class MyAgent extends OpenAiVoiceAgent {
  role: AgentRole = AgentRole.AGENT;

  constructor() {
    super({
      systemPrompt: `You are a helpful and engaging AI assistant.
      Respond naturally and conversationally since this is an audio conversation.
      Be informative but keep your responses short, concise and engaging.
      Adapt your speaking style to be natural for audio.`,
      voice: "echo",
    });
  }
}

/**
 * User simulator that generates audio questions
 *
 * This agent:
 * - Plays the role of a curious user asking questions
 * - Generates audio responses (not text)
 * - Uses role reversal to properly simulate user behavior
 * - Automatically ends conversation after 2 exchanges
 * - Uses "nova" voice to differentiate from main agent
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

  public async call(input: AgentInput): Promise<ModelMessage | string> {
    /**
     * Role reversal is critical here:
     * - The agent sees "user" messages as if they're from the assistant
     * - This allows the agent to respond AS the user
     * - Without this, the conversation flow would be backwards
     */
    const messages = messageRoleReversal(input.messages);
    return super.call({
      ...input,
      messages,
    });
  }
}

// Group related test runs together in the UI
const setId = "full-audio-conversation-test";

// Output path for the full conversation audio file
const outputPath = path.join(
  process.cwd(),
  "tmp",
  "audio_conversations",
  "full-conversation.wav"
);

describe.skipIf(skipInCi)("Multimodal Voice-to-Voice Conversation Tests", () => {
  it("should handle complete audio-to-audio conversation", async () => {
    // Initialize both agents for the conversation
    const audioUserSimulator = new AudioUserSimulatorAgent();
    const audioAgent = new MyAgent();

    // Create judge agent to evaluate conversation quality
    // Wrap with audio handler to transcribe audio before judging
    const conversationJudge = wrapJudgeForAudioTranscription(
      scenario.judgeAgent({ model: openai("gpt-5-mini") })
    );

    // Execute the full audio conversation scenario
    const result = await scenario.run({
      name: "full audio-to-audio conversation",
      description:
        "Complete audio conversation between user simulator and agent over multiple turns",
      agents: [audioAgent, audioUserSimulator, conversationJudge],
      script: [
        // Step 1: Run 2 conversation turns between user simulator and agent
        scenario.proceed(2),

        // Step 2: Save the full conversation as a single audio file
        async (ctx) => {
          await saveConversationAudio(ctx, outputPath);
        },

        // Step 3: Have judge evaluate the conversation quality
        scenario.judge({
          criteria: ["The conversation flows naturally between user and agent"],
        }),
      ],
      setId,
    });

    try {
      console.log("FULL AUDIO CONVERSATION RESULT", result);

      expect(result.success).toBe(true);
    } catch (error) {
      console.error("Full audio conversation failed:", result);
      throw error;
    }
  });

  /**
   * Future test ideas to expand audio conversation coverage:
   * - Longer multi-turn conversations (5+ exchanges)
   * - Emotional or empathetic audio responses
   * - Technical topic discussions requiring accuracy
   * - Handling interruptions or clarifications
   * - Multi-speaker scenarios (3+ participants)
   */
  it.todo("should handle longer audio conversations");
  it.todo("should handle audio conversation with emotional content");
  it.todo("should handle audio conversation with technical topics");
  it.todo("should handle audio conversation interruptions gracefully");
  it.todo("should handle audio conversation with multiple speakers");
});
