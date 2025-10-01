/**
 * OpenAI Voice Agent Tests
 *
 * This test suite demonstrates how to test voice-enabled agents that:
 * - Accept audio input (WAV files)
 * - Generate audio responses
 * - Handle multi-turn audio conversations
 *
 * These tests show patterns for working with the OpenAI audio API and
 * verifying audio content in agent responses.
 */
import * as fs from "fs";
import * as path from "path";
import { AgentInput, AgentRole } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";
import { encodeAudioToBase64 } from "./audio-encoding";
import { getFixturePath } from "./fixture-utils";
import { OpenAiVoiceAgent } from "./openai-voice-agent";

/**
 * Test agent that responds with audio
 * Uses OpenAI's voice-to-voice model to generate brief audio greetings
 */
class TestVoiceAgent extends OpenAiVoiceAgent {
  role: AgentRole = AgentRole.AGENT;

  constructor() {
    super({
      systemPrompt:
        "You are a helpful AI assistant. Respond with a brief audio greeting.",
      voice: "alloy",
    });
  }
}

describe("OpenAiVoiceAgent", () => {
  it("should accept and receive audio", async () => {
    // Setup: Create agent and load audio fixture
    const agent = new TestVoiceAgent();
    const audioFixture = getFixturePath("male_or_female_voice.wav");
    const audioData = encodeAudioToBase64(audioFixture);

    // Create multimodal input with both text and audio
    const input: AgentInput = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hello, can you hear me?",
            },
            {
              type: "file",
              mediaType: "audio/wav",
              data: audioData,
            },
          ],
        },
      ],
    };

    // Call agent with audio input
    const response = await agent.call(input);

    // Verify response structure
    expect(response).toBeDefined();
    expect(typeof response).toBe("object");
    expect(response).toHaveProperty("role");
    expect(response).toHaveProperty("content");
    expect(Array.isArray(response.content)).toBe(true);

    // Verify response contains audio data
    const hasAudio = response.content.some(
      (part: any) => part.type === "file" && part.mediaType === "audio/wav"
    );
    expect(hasAudio).toBe(true);

    // Optional: Save audio response to disk for manual verification
    const tmpDir = path.join(__dirname, "..", "..", "tmp");
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const audioPart = response.content.find(
      (part: any) => part.type === "file" && part.mediaType === "audio/wav"
    );

    if (audioPart) {
      const audioBuffer = Buffer.from(audioPart.data, "base64");
      const outputPath = path.join(tmpDir, "test-audio-response.wav");
      fs.writeFileSync(outputPath, audioBuffer);
      console.log(`Audio response saved to: ${outputPath}`);
    }
  });

  it.only("should handle multi-turn audio conversation", async () => {
    // Setup: Create agent and load two audio fixtures for multi-turn conversation
    const agent = new TestVoiceAgent();
    const audioFixture = getFixturePath("male_or_female_voice.wav");
    const audioFixture2 = getFixturePath("why_not_explain_yourself.wav");
    const audioData = encodeAudioToBase64(audioFixture);
    const audioData2 = encodeAudioToBase64(audioFixture2);

    // Initialize conversation with first user message
    const messages: AgentInput["messages"] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "",
          },
          {
            type: "file",
            mediaType: "audio/wav",
            data: audioData,
          },
        ],
      },
    ];

    // Turn 1: Get first agent response
    const firstResponse = await agent.call({ messages });
    expect(firstResponse).toBeDefined();
    expect(typeof firstResponse).toBe("object");

    // Add agent's first response to conversation history
    messages.push(firstResponse as any);

    // Turn 2: Add second user message to continue the conversation
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: "",
        },
        {
          type: "file",
          mediaType: "audio/wav",
          data: audioData2,
        },
      ],
    });

    // Turn 2: Get second agent response
    const secondResponse = await agent.call({ messages });
    expect(secondResponse).toBeDefined();
    expect(typeof secondResponse).toBe("object");

    // Verify both responses contain audio data
    const firstHasAudio = (firstResponse as any).content.some(
      (part: any) => part.type === "file" && part.mediaType === "audio/wav"
    );
    const secondHasAudio = (secondResponse as any).content.some(
      (part: any) => part.type === "file" && part.mediaType === "audio/wav"
    );

    expect(firstHasAudio).toBe(true);
    expect(secondHasAudio).toBe(true);

    // Optional: Save both audio responses for manual review
    const tmpDir = path.join(__dirname, "..", "..", "tmp");
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    // Helper function to extract and save audio from response
    const saveAudioResponse = (response: any, filename: string) => {
      const audioPart = response.content.find(
        (part: any) => part.type === "file" && part.mediaType === "audio/wav"
      );

      if (audioPart) {
        const audioBuffer = Buffer.from(audioPart.data, "base64");
        const outputPath = path.join(tmpDir, filename);
        fs.writeFileSync(outputPath, audioBuffer);
        console.log(`Audio response saved to: ${outputPath}`);
      }
    };

    saveAudioResponse(firstResponse, "conversation-turn-1.wav");
    saveAudioResponse(secondResponse, "conversation-turn-2.wav");

    // Verify conversation history structure (2 user messages + 1 agent response in messages array)
    expect(messages.length).toBe(3);
  });
});
