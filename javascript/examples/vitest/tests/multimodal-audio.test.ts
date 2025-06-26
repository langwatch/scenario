import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText } from "ai";
import { describe, it, expect } from "vitest";

const setId = "multimodal-audio-test";

// Helper function to convert text to speech (using OpenAI TTS API)
async function textToSpeech(
  text: string,
  voice: string = "alloy"
): Promise<ArrayBuffer> {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      voice,
      input: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`TTS API error: ${response.status} ${response.statusText}`);
  }

  return await response.arrayBuffer();
}

describe("Multimodal Audio Tests", () => {
  // Create an agent that can handle audio input
  const audioAgent: AgentAdapter = {
    role: AgentRole.AGENT,
    call: async (input) => {
      const response = await generateText({
        model: openai("gpt-4o-audio-preview"),
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant that can process both text and audio input. Respond naturally to user queries.",
          },
          ...input.messages,
        ],
      });
      return response.text;
    },
  };

  it("should process text and audio input together", async () => {
    // Create the audio file first
    const audioBuffer = await textToSpeech("Hello, I need help with my order");

    const audioMessage = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "What did I say in the audio?" },
        {
          type: "file" as const,
          mimeType: "audio/mpeg",
          data: Buffer.from(audioBuffer),
          filename: "audio_input.mp3",
        },
      ],
    };

    const result = await scenario.run({
      name: "multimodal audio test",
      description:
        "User sends both text and audio, agent processes both inputs",
      agents: [
        audioAgent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          criteria: [
            "Agent acknowledges both text and audio input",
            "Agent provides a helpful response",
            "Agent demonstrates understanding of the multimodal input",
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

    expect(result.success).toBe(true);
  });

  it.todo("should handle audio-only input");
  it.todo("should handle different audio voices");
  it.todo("should fallback gracefully when TTS fails");
});
