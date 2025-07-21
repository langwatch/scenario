import { openai } from "@ai-sdk/openai";
import scenario, { AgentRole } from "@langwatch/scenario";
import { CoreUserMessage } from "ai";
import { describe, it, expect } from "vitest";
import {
  encodeAudioToBase64,
  getFixturePath,
} from "./helpers";
import { OpenAiVoiceAgent } from "./helpers/openai-voice-agent";

class AudioAgent extends OpenAiVoiceAgent {
  role: AgentRole = AgentRole.AGENT;
}

// Use setId to group together for visualizing in the UI
const setId = "multimodal-audio-test";

/**
 * This example shows how to test an agent that can take audio input
 * from a fixture and respond with audio output.
 */
describe("Multimodal Audio to Audio Tests", () => {
  it("should handle audio input", async () => {
    const myAgent = new AudioAgent({
      systemPrompt: `
      You are a helpful assistant that can analyze audio input and respond with audio output.
      You must respond with audio output.
      `,
      voice: "alloy",
      forceUserRole: true,
    });

    const data = encodeAudioToBase64(
      getFixturePath("male_or_female_voice.wav")
    );

    // The AI-SDK will only support file parts,
    // so we cannot use the OpenAI shape from above
    // @see https://ai-sdk.dev/docs/foundations/prompts#file-parts
    const audioMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: `
          Answer the question in the a text.
          If you're not sure, you're required to take a best guess.
          After you've guessed, you must repeat the question and say what format the input was in (audio or text)
          `,
        },
        {
          type: "file",
          mimeType: "audio/wav",
          data,
        },
      ],
    } satisfies CoreUserMessage;

    const audioJudge = scenario.judgeAgent({
      // We to use this model to correctly handle the audio input
      model: openai("gpt-4o-audio-preview"),
      criteria: [
        "The agent correctly guesses it's a male voice",
        "The agent repeats the question",
        "The agent says what format the input was in (audio or text)",
      ],
    });

    const result = await scenario.run({
      setId,
      name: "multimodal audio analysis",
      description:
        "User sends audio file, agent analyzes and transcribes the content",
      agents: [myAgent, scenario.userSimulatorAgent(), audioJudge],
      script: [
        scenario.message(audioMessage),
        scenario.agent(),
        scenario.judge(),
      ],
    });

    try {
      console.log("RESULT", result);
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
