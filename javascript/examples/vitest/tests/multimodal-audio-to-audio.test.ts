import scenario, {
  AgentAdapter,
  AgentInput,
  AgentRole,
} from "@langwatch/scenario";
import { describe, it, expect } from "vitest";
import OpenAI from "openai";
import { openai } from "@ai-sdk/openai";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import { encodeAudioToBase64, getFixturePath } from "./helpers";
import { CoreAssistantMessage, CoreUserMessage } from "ai";
import { convertCoreMessagesToOpenAIMessages } from "./helpers/convert-core-messages-to-openai";

class AudioAgent extends AgentAdapter {
  role: AgentRole = AgentRole.AGENT;
  private openai = new OpenAI();

  call = async (input: AgentInput) => {
    // To use the OpenAI "voice-to-voice" model, we need to use the
    // OpenAI api directly, and so we need to convert the messages to the correct
    // shape here.
    // @see https://platform.openai.com/docs/guides/audio?example=audio-in
    const messages = convertCoreMessagesToOpenAIMessages(input.messages);
    const response = await this.respond(messages);

    // Extract both audio data and transcript from the response
    const audioData = response.choices[0].message?.audio?.data;
    const transcript = response.choices[0].message?.audio?.transcript;

    // Return a CoreMessage with both audio and text content
    if (audioData) {
      console.log("RESPONSDING IN AUDIO", transcript);
      return {
        role: "user",
        content: [
          {
            type: "file",
            mimeType: "audio/wav",
            data: audioData,
          },
        ],
      } as CoreUserMessage;
    } else if (transcript) {
      console.log("FALLBACK TO TEXT", transcript);
      // Fallback to text-only if audio data is not available
      return "GET OUT OF MY HEAD, CHICKEN SOUP";
    } else {
      throw new Error("Agent failed to generate a response");
    }
  };

  private async respond(messages: ChatCompletionMessageParam[]) {
    return await this.openai.chat.completions.create({
      model: "gpt-4o-audio-preview",
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "wav" },
      // We need to strip the id, or the openai client will throw an error
      messages,
      store: false,
    });
  }
}

// Use setId to group together for visualizing in the UI
const setId = "multimodal-audio-test";

describe("Multimodal Audio Tests", () => {
  it("should handle audio input", async () => {
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
          Answer the question in the audio or text.
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
      name: "multimodal audio analysis",
      description:
        "User sends audio file, agent analyzes and transcribes the content",
      agents: [new AudioAgent(), scenario.userSimulatorAgent(), audioJudge],
      script: [
        scenario.message(audioMessage),
        scenario.agent(),
        scenario.judge(),
      ],
      setId,
    });

    try {
      console.log("RESULT", result);
      expect(result.success).toBe(true);
    } catch (error) {
      console.error(result);
      throw error;
    }
  });

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
