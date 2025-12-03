/**
 * Multimodal Voice-to-Voice Conversation Tests
 *
 * This test suite demonstrates voice-first-class primitives for audio conversations:
 *
 * Voice Script Primitives:
 * - scenario.user.speak("text") — Fixed user message converted to audio via TTS
 * - scenario.agent.speak("text") — Fixed agent message converted to audio via TTS
 * - scenario.user() with voice sim — Generated audio responses
 *
 * Voice User Simulator:
 * - scenario.userSimulatorAgent({ voice: "nova" }) — Generates audio instead of text
 *
 * Audio-Aware Judge:
 * - scenario.judgeAgent({ audio: true }) — Evaluates audio content directly
 */
import * as path from "path";
import { openai } from "@ai-sdk/openai";
import scenario, { AgentRole } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";
import { OpenAiVoiceAgent, saveConversationAudio } from "./helpers";

// Skipped in CI: depends on the OpenAI `gpt-4o-audio-preview` model, which
// returns 404 model_not_found as of 2026-05-19. Tracked separately — the
// voice work PR will unskip these tests once model access is restored.
const skipInCi = process.env.CI === "true";

/**
 * Voice agent that responds with audio
 */
class VoiceAgent extends OpenAiVoiceAgent {
  role: AgentRole = AgentRole.AGENT;

  constructor() {
    super({
      systemPrompt: `You are a helpful AI assistant having a voice conversation.
      Keep responses short and conversational.`,
      voice: "echo",
    });
  }
}

const setId = "voice-conversation-tests";
const outputPath = path.join(process.cwd(), "tmp", "audio_conversations");

describe.skipIf(skipInCi)("Voice-to-Voice Conversation Tests", () => {
  /**
   * Example 1: Fixed voice messages using .speak()
   *
   * Use scenario.user.speak() and scenario.agent.speak() when you want
   * specific text converted to audio via TTS.
   */
  it.only("should handle fixed voice messages with .speak()", async () => {
    const result = await scenario.run({
      name: "fixed voice messages",
      description: "Test with predetermined voice messages",
      agents: [
        new VoiceAgent(),
        scenario.userSimulatorAgent(), // Text sim (not used in this script)
        scenario.judgeAgent({
          model: openai("gpt-4o-audio-preview"),
          criteria: ["Agent responds appropriately to greeting"],
          audio: true,
        }),
      ],
      script: [
        // Fixed user voice message via TTS
        scenario.user.speak("Hello! Can you help me with something?"),
        scenario.agent(), // Agent generates audio response
        scenario.judge(),
      ],
      setId,
    });

    expect(result.success).toBe(true);
  });

  /**
   * Example 2: Voice user simulator generates audio
   *
   * Use scenario.userSimulatorAgent({ voice }) to have the simulator
   * generate contextual responses as audio.
   */
  it("should handle voice user simulator", async () => {
    const result = await scenario.run({
      name: "voice user simulator",
      description:
        "User is asking about cooking, keeping the conversation short and natural for voice.",
      agents: [
        new VoiceAgent(),
        // Voice user sim - generates audio via TTS
        scenario.userSimulatorAgent({
          voice: "nova",
          systemPrompt: `You are a curious user asking about cooking.
          Keep questions short and natural for voice.`,
        }),
        scenario.judgeAgent({
          model: openai("gpt-4o"),
          criteria: ["Conversation flows naturally"],
          audio: true,
        }),
      ],
      script: [
        scenario.user(), // Voice sim generates audio
        scenario.agent(), // Agent responds with audio
        scenario.user(), // Voice sim generates follow-up audio
        scenario.agent(),
        scenario.judge(),
      ],
      setId,
    });

    expect(result.success).toBe(true);
  });

  /**
   * Example 3: Mixed text and voice in same conversation
   *
   * You can mix text and voice messages. The voice sim only generates
   * audio when scenario.user() has no arguments.
   */
  it("should handle mixed text and voice messages", async () => {
    const result = await scenario.run({
      name: "mixed text and voice",
      description: "Combining text and voice in one conversation",
      agents: [
        new VoiceAgent(),
        scenario.userSimulatorAgent({ voice: "nova" }),
        scenario.judgeAgent({
          model: openai("gpt-4o"),
          criteria: ["Agent handles both text and voice input"],
          audio: true,
        }),
      ],
      script: [
        // Text message (not converted to audio)
        scenario.user("Hi, I need a recipe suggestion"),
        scenario.agent(),
        // Voice sim generates audio follow-up
        scenario.user(),
        scenario.agent(),
        // Fixed voice message via TTS
        scenario.user.speak("Thanks, that sounds delicious!"),
        scenario.agent(),
        scenario.judge(),
      ],
      setId,
    });

    expect(result.success).toBe(true);
  });

  /**
   * Example 4: Multi-turn voice conversation with audio export
   */
  it("should handle multi-turn voice conversation", async () => {
    const result = await scenario.run({
      name: "multi-turn voice conversation",
      description: "Extended voice conversation with audio export",
      agents: [
        new VoiceAgent(),
        scenario.userSimulatorAgent({
          voice: "nova",
          systemPrompt: `You are learning about AI testing.
          Ask 2-3 questions then say goodbye.`,
        }),
        scenario.judgeAgent({
          model: openai("gpt-4o"),
          criteria: ["Conversation is informative and helpful"],
          audio: true,
        }),
      ],
      script: [
        scenario.proceed(3), // 3 turns of voice conversation
        async (ctx) => {
          await saveConversationAudio(
            ctx,
            path.join(outputPath, "multi-turn.wav")
          );
        },
        scenario.judge(),
      ],
      setId,
    });

    expect(result.success).toBe(true);
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
