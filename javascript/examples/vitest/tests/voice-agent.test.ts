import * as fs from "fs";
import * as path from "path";
import { openai } from "@ai-sdk/openai";
import scenario, { AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText } from "ai";
import OpenAI from "openai"; 
import { describe, it, expect } from "vitest";

const setId = "realtime-voice-agent-test";

const openaiRaw = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

function getFixtureAudioPath(): string {
  return path.join(__dirname, "fixtures", "sample.wav");
}

async function transcribeAudio(): Promise<string> {
  const audioPath = getFixtureAudioPath();
  const file = fs.createReadStream(audioPath);
  const response = await openaiRaw.audio.transcriptions.create({
    file,
    model: "whisper-1",
    response_format: "text",
  });
  return response;
}

describe("Voice Agent Audio Tests", () => {
  const voiceAgent: AgentAdapter = {
    role: AgentRole.AGENT,
    call: async (input) => {
      const response = await generateText({
        model: openai("gpt-4o"),
        messages: [
          {
            role: "system",
            content: `You are a helpful assistant. Respond to the user's transcribed voice message.`,
          },
          ...input.messages,
        ],
      });
      return response.text;
    },
  };

  it("should respond to a transcribed voice message", async () => {
    const transcript = await transcribeAudio();

    const result = await scenario.run({
      name: "voice agent: with whisper",
      description: "Transcribe audio, then test agent response",
      agents: [
        voiceAgent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          criteria: [
            "Agent responds clearly to the user's voice message",
            "Agent tone is conversational and helpful",
          ],
        }),
      ],
      script: [
        scenario.message({
          role: "user",
          content: `🗣️ (Transcribed) ${transcript}`,
        }),
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
});
