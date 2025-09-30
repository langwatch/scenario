import * as fs from "fs";
import * as path from "path";
import { AgentInput, AgentRole } from "@langwatch/scenario";
import { describe, it, expect } from "vitest";
import { encodeAudioToBase64 } from "./audio-encoding";
import { getFixturePath } from "./fixture-utils";
import { OpenAiVoiceAgent } from "./openai-voice-agent";

/**
 * Test agent that responds with audio
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
    const agent = new TestVoiceAgent();
    const audioFixture = getFixturePath("male_or_female_voice.wav");
    const audioData = encodeAudioToBase64(audioFixture);

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

    const response = await agent.call(input);

    expect(response).toBeDefined();
    expect(typeof response).toBe("object");
    expect(response).toHaveProperty("role");
    expect(response).toHaveProperty("content");
    expect(Array.isArray(response.content)).toBe(true);

    // Check if response contains audio
    const hasAudio = response.content.some(
      (part: any) => part.type === "file" && part.mediaType === "audio/wav"
    );
    expect(hasAudio).toBe(true);

    // Save audio to tmp file
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
    const agent = new TestVoiceAgent();
    const audioFixture = getFixturePath("male_or_female_voice.wav");
    const audioFixture2 = getFixturePath("why_not_explain_yourself.wav");
    const audioData = encodeAudioToBase64(audioFixture);
    const audioData2 = encodeAudioToBase64(audioFixture2);

    // First message
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

    // First agent response
    const firstResponse = await agent.call({ messages });
    expect(firstResponse).toBeDefined();
    expect(typeof firstResponse).toBe("object");

    // Add agent response to conversation
    messages.push(firstResponse as any);

    // Add second user message
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

    // Second agent response
    const secondResponse = await agent.call({ messages });
    expect(secondResponse).toBeDefined();
    expect(typeof secondResponse).toBe("object");

    // Verify both responses contain audio
    const firstHasAudio = (firstResponse as any).content.some(
      (part: any) => part.type === "file" && part.mediaType === "audio/wav"
    );
    const secondHasAudio = (secondResponse as any).content.some(
      (part: any) => part.type === "file" && part.mediaType === "audio/wav"
    );

    expect(firstHasAudio).toBe(true);
    expect(secondHasAudio).toBe(true);

    // Save both audio responses to tmp files
    const tmpDir = path.join(__dirname, "..", "..", "tmp");
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

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

    // Verify we have 3 messages total (2 user + 1 agent response)
    expect(messages.length).toBe(3);
  });
});
