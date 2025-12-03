import { openai } from "@ai-sdk/openai";
import scenario, { AgentRole, audioFromFile } from "@langwatch/scenario";
import { UserModelMessage } from "ai";
import { describe, it, expect } from "vitest";
import { getFixturePath } from "./helpers";
import { OpenAiVoiceAgent } from "./helpers/openai-voice-agent";

// Skipped in CI: depends on the OpenAI `gpt-4o-audio-preview` model, which
// returns 404 model_not_found as of 2026-05-19. Tracked separately — the
// voice work PR will unskip these tests once model access is restored.
const skipInCi = process.env.CI === "true";

class AudioAgent extends OpenAiVoiceAgent {
  role: AgentRole = AgentRole.AGENT;
}

const setId = "multimodal-audio-test";

/**
 * This example shows how to test an agent that can take audio input
 * from a fixture and respond with audio output.
 *
 * Uses:
 * - audioFromFile() to load audio
 * - scenario.message() to inject the audio message
 * - scenario.judgeAgent({ audio: true }) for multimodal evaluation
 */
describe.skipIf(skipInCi)("Multimodal Audio to Audio Tests", () => {
  it("should handle audio input from file", async () => {
    const myAgent = new AudioAgent({
      systemPrompt: `You are a helpful assistant that analyzes audio input.
      Answer questions about the audio content.`,
      voice: "alloy",
      forceUserRole: true,
    });

    // Load audio file using the utility
    const audio = audioFromFile(getFixturePath("male_or_female_voice.wav"));

    // Create audio message with instructions
    const audioMessage: UserModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "Is this a male or female voice? Take a guess." },
        { type: "file", mediaType: audio.mediaType, data: audio.data },
      ],
    };

    const result = await scenario.run({
      setId,
      name: "audio to audio - file input",
      description: "User sends audio file, agent analyzes and responds",
      agents: [
        myAgent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          model: openai("gpt-4o"),
          criteria: ["The agent guesses the voice gender"],
          audio: true,
        }),
      ],
      script: [
        scenario.message(audioMessage),
        scenario.agent(),
        scenario.judge({
          criteria: [
            "The agent correctly guesses it's a male voice",
            "The agent repeats the question",
            "The agent says what format the input was in (audio or text)",
          ],
        }),
      ],
    });

    try {
      expect(result.success).toBe(true);
    } catch (error) {
      console.error(result);
      throw error;
    }
  });

  // Ideas for future tests
  it.todo("should handle audio-only input without text");
  it.todo("should handle multiple audio formats (WAV, MP3, M4A)");
  it.todo("should handle long audio files gracefully");
  it.todo(
    "should provide appropriate responses for unclear or corrupted audio"
  );
  it.todo("should handle audio with background noise");
  it.todo("should transcribe speech in different languages");
  it.todo("should identify non-speech audio content (music, sounds, etc.)");
  it.todo("should handle multiple audio files in a single message");
  it.todo("should process audio with text instructions effectively");
});
