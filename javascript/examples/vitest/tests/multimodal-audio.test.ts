import * as fs from "fs";
import * as path from "path";
import { openai } from "@ai-sdk/openai";
import scenario, {
  AgentAdapter,
  AgentInput,
  AgentReturnTypes,
  AgentRole,
} from "@langwatch/scenario";
import { CoreUserMessage, generateText } from "ai";
import { describe, it, expect } from "vitest";
import OpenAI from "openai";

console.error(new Error().stack);

// Use setId to group together for visualizing in the UI
const setId = "multimodal-audio-test";

/**
 * Helper function to encode audio file to base64
 * @param filePath - Path to the audio file
 * @returns Base64 encoded audio data
 */
function encodeAudioToBase64(filePath: string): string {
  const audioBuffer = fs.readFileSync(filePath);
  return Buffer.from(audioBuffer).toString("base64");
}

/**
 * Helper function to create audio data URL
 * @param audioPath - Path to the audio file
 * @param mimeType - MIME type of the audio file (e.g., "audio/wav", "audio/mp3")
 * @returns Data URL string for the audio
 */
function createAudioDataURL(
  audioPath: string,
  mimeType: string = "audio/wav"
): string {
  const base64Audio = encodeAudioToBase64(audioPath);
  return `data:${mimeType};base64,${base64Audio}`;
}

/**
 * Helper function to decode base64 audio and save to file
 * @param base64Audio - Base64 encoded audio data
 * @param outputPath - Path where to save the audio file
 */
function saveAudioFromBase64(base64Audio: string, outputPath: string): void {
  const audioBuffer = Buffer.from(base64Audio, "base64");
  fs.writeFileSync(outputPath, audioBuffer);
}

/**
 * Get output path for saved audio files
 * @param filename - Name of the audio file
 * @returns Path to save the audio file
 */
function getOutputAudioPath(filename: string): string {
  return path.join(__dirname, "fixtures", filename);
}

/**
 * Get the fixture audio file path
 * Note: You'll need to add an audio fixture file to the fixtures directory
 * @returns Path to the test audio file
 */
function getFixtureAudioPath(name: string): string {
  // For this example, we'll assume you have a test audio file
  // You can create a simple WAV file or use any short audio sample
  return path.join(__dirname, "fixtures", name);
}

describe("Multimodal Audio Tests", () => {
  class AudioAgent extends AgentAdapter {
    role: AgentRole = AgentRole.AGENT;
    private openai = new OpenAI();

    constructor() {
      super();
    }

    call = async (input: AgentInput) => {
      const response = await this.generateText(input);
      const message = response.choices[0].message;

      // Handle audio response
      if (message.audio?.data) {
        const audioId = message.audio.id;
        const outputPath = getOutputAudioPath(`response_${audioId}.wav`);

        // Save the audio file
        saveAudioFromBase64(message.audio.data, outputPath);

        console.log(`Audio response saved to: ${outputPath}`);

        // Return a text description of what happened
        return `I processed the audio input and generated an audio response. The audio file has been saved to ${outputPath}. The audio ID is ${audioId}.`;
      }

      // Handle text response
      if (message.content) {
        return message.content;
      }

      // Fallback if neither content nor audio is available
      return "I received the audio input but was unable to generate a response.";
    };

    private async generateText(input: AgentInput) {
      const audioMessage = {
        role: "user",
        content: [
          {
            type: "text",
            text: "Please transcribe and analyze this audio:",
          },
          {
            type: "input_audio",
            input_audio: {
              data: encodeAudioToBase64(
                getFixtureAudioPath("male_or_female_voice.wav")
              ),
              format: "wav",
            },
          },
        ],
      } as CoreUserMessage;

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-audio-preview",
        modalities: ["text", "audio"],
        audio: { voice: "alloy", format: "wav" },
        messages: [audioMessage],
        store: true,
      });

      console.log("response", JSON.stringify(response, null, 2));

      return response;
    }
  }

  it("should process audio input and provide transcription/analysis", async () => {
    const audioMessage = {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: "Please transcribe and analyze this audio:",
        },
        {
          type: "input_audio" as const,
          input_audio: {
            data: encodeAudioToBase64(
              getFixtureAudioPath("male_or_female_voice.wav")
            ),
            format: "wav",
          },
        },
      ],
    } as CoreUserMessage;

    const result = await scenario.run({
      name: "multimodal audio analysis",
      description:
        "User sends audio file, agent analyzes and transcribes the content",
      agents: [
        new AudioAgent(),
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          criteria: [
            "Agent acknowledges the audio input",
            "Agent attempts to process or transcribe the audio",
            "Agent provides appropriate feedback about audio content",
            "Agent demonstrates understanding of multimodal input",
          ],
        }),
      ],
      script: [
        scenario.message(audioMessage),
        scenario.agent(),
        scenario.judge(),
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
