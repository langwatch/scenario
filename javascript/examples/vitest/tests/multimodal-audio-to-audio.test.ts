import { openai } from "@ai-sdk/openai";
import scenario, { AgentRole } from "@langwatch/scenario";
import { UserModelMessage } from "ai";
import { describe, it, expect } from "vitest";
import {
  encodeAudioToBase64,
  getFixturePath,
  wrapJudgeForAudioTranscription,
} from "./helpers";
import OpenAI from "openai";

// Skipped in CI: depends on the OpenAI `gpt-4o-audio-preview` model, which
// returns 404 model_not_found as of 2026-05-19. Tracked separately — the
// voice work PR will unskip these tests once model access is restored.
const skipInCi = process.env.CI === "true";

const openaiDirectClient = new OpenAI();

// Custom agent that handles audio input/output directly
const audioAgent = {
  role: AgentRole.AGENT,
  call: async (input) => {
    // Convert messages to OpenAI format
    const messages = input.messages.map((msg) => {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        // Handle audio input
        const audioPart = msg.content.find(
          (part) => part.type === "file" && part.mediaType?.startsWith("audio/")
        );
        if (audioPart) {
          return {
            role: "user",
            content: [
              {
                type: "text",
                text: "Analyze this audio and respond with audio.",
              },
              {
                type: "input_audio",
                input_audio: {
                  data: audioPart.data,
                  format: "wav",
                },
              },
            ],
          };
        }
      }
      return msg;
    });

    // Call OpenAI audio API
    const response = await openaiDirectClient.chat.completions.create({
      model: "gpt-4o-audio-preview",
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "wav" },
      messages,
    });

    // Return audio response
    const audioData = response.choices[0].message?.audio?.data;
    if (audioData) {
      return {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "file", mediaType: "audio/wav", data: audioData },
        ],
      };
    }

    throw new Error("No audio response generated");
  },
};

// Use setId to group together for visualizing in the UI
const setId = "multimodal-audio-test";

/**
 * This example shows how to test an agent that can take audio input
 * from a fixture and respond with audio output.
 */
describe.skipIf(skipInCi)("Multimodal Audio to Audio Tests", () => {
  it("should handle audio input", async () => {
    const myAgent = audioAgent;

    const data = encodeAudioToBase64(
      getFixturePath("male_or_female_voice.wav"),
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
          mediaType: "audio/wav",
          data,
        },
      ],
    } satisfies UserModelMessage;

    const audioJudge = wrapJudgeForAudioTranscription(
      scenario.judgeAgent({ model: openai("gpt-5-mini") }),
    );

    const result = await scenario.run({
      setId,
      name: "multimodal audio to audio",
      description:
        "User sends audio file, agent analyzes and transcribes the content",
      agents: [myAgent, scenario.userSimulatorAgent(), audioJudge],
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
    "should provide appropriate responses for unclear or corrupted audio",
  );
  it.todo("should handle audio with background noise");
  it.todo("should transcribe speech in different languages");
  it.todo("should identify non-speech audio content (music, sounds, etc.)");
  it.todo("should handle multiple audio files in a single message");
  it.todo("should process audio with text instructions effectively");
});
