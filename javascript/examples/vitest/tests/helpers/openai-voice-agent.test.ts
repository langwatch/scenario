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
import { FilePart, ModelMessage, TextPart } from "ai";
import { describe, it, expect } from "vitest";
import { encodeAudioToBase64 } from "./audio-encoding";
import { getFixturePath } from "./fixture-utils";
import { OpenAiVoiceAgent } from "./openai-voice-agent";

// Skipped in CI: live end-to-end test — calls OpenAI's `gpt-audio-mini` audio
// model and the real LangWatch backend (cost, API keys, non-deterministic
// audio), so it runs live/locally rather than in CI. The skip historically
// also guarded the now-deleted `gpt-4o-audio-preview` (404 model_not_found
// since 2026-05-19); #607 swapped that dead model for `gpt-audio-mini`, so the
// model is no longer the blocker — the skip is CI-cost/live-only now.
const skipInCi = process.env.CI === "true";

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

describe.skipIf(skipInCi)("OpenAiVoiceAgent", () => {
  /**
   * Tests basic audio input/output functionality
   *
   * Verifies that the agent can:
   * - Accept multimodal input (text + audio)
   * - Generate audio responses
   * - Return properly structured ModelMessage with audio content
   */
  it("should accept and receive audio", async () => {
    // Setup: Create agent and load audio fixture
    const agent = new TestVoiceAgent();
    const audioFixture = getFixturePath("male_or_female_voice.wav");
    const audioData = encodeAudioToBase64(audioFixture);

    // Create multimodal input with both text and audio
    const input = {
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
    } as AgentInput;

    // Call agent with audio input
    const response = await agent.call(input);

    // Verify response structure
    expect(response).toBeDefined();
    expect(typeof response).toBe("object");
    expect(response).toHaveProperty("role");
    expect(response).toHaveProperty("content");

    const content = (response as ModelMessage).content as (
      | TextPart
      | FilePart
    )[];

    expect(Array.isArray(content)).toBe(true);

    // Verify response contains audio data
    const hasAudio = content.some(
      (part: FilePart) => part.type === "file" && part.mediaType === "audio/wav"
    );
    expect(hasAudio).toBe(true);

    // Optional: Save audio response to disk for manual verification
    const tmpDir = path.join(__dirname, "..", "..", "tmp");
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const audioPart = content.find(
      (part: FilePart) => part.type === "file" && part.mediaType === "audio/wav"
    ) as FilePart;

    if (audioPart) {
      const audioBuffer = Buffer.from(audioPart.data as string, "base64");
      const outputPath = path.join(tmpDir, "test-audio-response.wav");
      fs.writeFileSync(outputPath, audioBuffer);
      console.log(`Audio response saved to: ${outputPath}`);
    }
  });

  /**
   * Tests multi-turn audio conversation handling
   *
   * Verifies that the agent can:
   * - Maintain conversation context across multiple turns
   * - Handle sequential audio inputs from user
   * - Generate appropriate audio responses for each turn
   * - Preserve conversation history structure
   *
   * Flow: User audio → Agent audio → User audio → Agent audio
   */
  it("should handle multi-turn audio conversation", async () => {
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
    const firstResponse = (await agent.call({
      messages,
    } as AgentInput)) as ModelMessage;

    expect(firstResponse).toBeDefined();

    // Add agent's first response to conversation history
    messages.push(firstResponse);

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
    const secondResponse = await agent.call({ messages } as AgentInput);
    expect(secondResponse).toBeDefined();
    expect(typeof secondResponse).toBe("object");

    const firstResponseContent = (firstResponse as ModelMessage).content as (
      | TextPart
      | FilePart
    )[];

    const secondResponseContent = (secondResponse as ModelMessage).content as (
      | TextPart
      | FilePart
    )[];

    // Verify both responses contain audio data
    const firstHasAudio = firstResponseContent.some(
      (part: FilePart) => part.type === "file" && part.mediaType === "audio/wav"
    );
    const secondHasAudio = secondResponseContent.some(
      (part: FilePart) => part.type === "file" && part.mediaType === "audio/wav"
    );

    expect(firstHasAudio).toBe(true);
    expect(secondHasAudio).toBe(true);

    // Optional: Save both audio responses for manual review
    const tmpDir = path.join(__dirname, "..", "..", "tmp");
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    /**
     * Helper function to extract and save audio from response content
     * @param responseContent - Array of content parts from ModelMessage
     * @param filename - Output filename for the audio file
     */
    const saveAudioResponse = (
      responseContent: (TextPart | FilePart)[],
      filename: string
    ) => {
      const audioPart = responseContent.find(
        (part: FilePart) =>
          part.type === "file" && part.mediaType === "audio/wav"
      ) as FilePart;

      if (audioPart) {
        const audioBuffer = Buffer.from(audioPart.data as string, "base64");
        const outputPath = path.join(tmpDir, filename);
        fs.writeFileSync(outputPath, audioBuffer);
        console.log(`Audio response saved to: ${outputPath}`);
      }
    };

    saveAudioResponse(firstResponseContent, "conversation-turn-1.wav");
    saveAudioResponse(secondResponseContent, "conversation-turn-2.wav");

    // Verify conversation history structure (2 user messages + 1 agent response in messages array)
    expect(messages.length).toBe(3);
  });
});
