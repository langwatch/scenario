import { openai } from "@ai-sdk/openai";
import scenario, {
  AgentAdapter,
  AgentInput,
  AgentRole,
  audioFromFile,
} from "@langwatch/scenario";
import { UserModelMessage } from "ai";
import OpenAI from "openai";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import { describe, it, expect } from "vitest";
import { getFixturePath } from "./helpers";
import { convertModelMessagesToOpenAIMessages } from "./helpers/convert-core-messages-to-openai";

// Skipped in CI: depends on the OpenAI `gpt-4o-audio-preview` model, which
// returns 404 model_not_found as of 2026-05-19. Tracked separately — the
// voice work PR will unskip these tests once model access is restored.
const skipInCi = process.env.CI === "true";

/**
 * Agent that takes audio input and responds with text
 */
class AudioToTextAgent extends AgentAdapter {
  role: AgentRole = AgentRole.AGENT;
  private openai = new OpenAI();

  call = async (input: AgentInput) => {
    const messages = convertModelMessagesToOpenAIMessages(input.messages);
    const response = await this.respond(messages);
    const transcript = response.choices[0].message?.audio?.transcript;

    if (typeof transcript === "string") {
      return transcript;
    }
    throw new Error("Agent failed to generate a response");
  };

  private async respond(messages: ChatCompletionMessageParam[]) {
    return await this.openai.chat.completions.create({
      model: "gpt-4o-audio-preview",
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "wav" },
      messages,
      store: false,
    });
  }
}

const setId = "multimodal-audio-test";

/**
 * This example shows how to test an agent that takes audio input
 * and responds with text output.
 *
 * Uses:
 * - audioFromFile() to load audio
 * - scenario.message() to inject the audio message
 * - scenario.judgeAgent({ audio: true }) for multimodal evaluation
 */
describe.skipIf(skipInCi)("Multimodal Audio to Text Tests", () => {
  it("should handle audio input from file", async () => {
    // Load audio file
    const audio = audioFromFile(getFixturePath("male_or_female_voice.wav"));

    const audioMessage: UserModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "Is this a male or female voice?" },
        { type: "file", mediaType: audio.mediaType, data: audio.data },
      ],
    };

    const result = await scenario.run({
      name: "audio to text",
      description: "User sends audio, agent responds with text",
      agents: [
        new AudioToTextAgent(),
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          model: openai("gpt-4o"),
          criteria: ["The agent identifies the voice gender"],
          audio: true,
        }),
      ],
      script: [
        scenario.message(audioMessage),
        scenario.agent(),
        scenario.judge({
          criteria: [
            "The agent guesses it's a male voice",
            "The agent repeats the question",
            "The agent says what format the input was in (audio or text)",
          ],
        }),
      ],
      setId,
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
  it.todo("should handle multiple audio formats (WAV, MP3)");
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
