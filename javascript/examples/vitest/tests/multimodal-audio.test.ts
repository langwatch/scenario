import scenario, {
  AgentAdapter,
  AgentInput,
  AgentRole,
  MultimodalAudioMessage,
} from "@langwatch/scenario";
import { describe, it, expect } from "vitest";
import OpenAI from "openai";
import { openai } from "@ai-sdk/openai";

import { encodeAudioToBase64, getFixtureAudioPath } from "./helpers";
import { CoreMessage, CoreUserMessage } from "ai";
import { convertCoreMessagesToOpenAIMessages } from "../../../src/utils/convert-core-messages-to-openai";

class AudioAgent extends AgentAdapter {
  role: AgentRole = AgentRole.AGENT;
  private openai = new OpenAI();

  constructor() {
    super();
  }

  call = async (input: AgentInput) => {
    const response = await this.respond(input);

    // Since we are
    // audio from "assistant" messages
    const message = response.choices[0].message?.audio?.transcript;

    // Handle text response
    if (typeof message === "string") {
      return message;
    } else {
      throw new Error("Agent failed to generate a response");
    }
  };

  private async respond(input: AgentInput) {
    const messages = convertCoreMessagesToOpenAIMessages(input.messages);
    console.log("messages", messages);
    return await this.openai.chat.completions.create({
      model: "gpt-4o-audio-preview",
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "wav" },
      // We need to strip the id, or the openai client will throw an error
      messages,
      store: false,
    });
  }

  private convertToOpenAIMessages(messages: CoreMessage[]) {
    return convertCoreMessagesToOpenAIMessages(messages);
  }
}

// Use setId to group together for visualizing in the UI
const setId = "multimodal-audio-test";

describe("Multimodal Audio Tests", () => {
  it("should handle audio input", async () => {
    const data = encodeAudioToBase64(
      getFixtureAudioPath("male_or_female_voice.wav")
    );

    // The AI-SDK will only support file parts,
    // so we cannot use the OpenAI shape from above
    const audioMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: `
          Answer the question in the audio.
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

    const judge = scenario.judgeAgent({
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
      agents: [new AudioAgent(), scenario.userSimulatorAgent(), judge],
      script: [
        scenario.message(audioMessage),
        scenario.agent(),
        scenario.judge(),
      ],
      setId,
    });

    try {
      console.log(
        "result",
        JSON.stringify(
          {
            ...result,
            messages: result.messages.map((m) => ({
              ...m,
              content: !Array.isArray(m.content)
                ? m.content
                : m.content.map((c) => {
                    if (c.type === "input_audio") {
                      return {
                        ...c,
                        input_audio: {
                          ...c.input_audio,
                          data: "[base64 data]",
                        },
                      };
                    }
                  }),
            })),
          },
          null,
          2
        )
      );

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
