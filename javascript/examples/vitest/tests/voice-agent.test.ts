import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import { describe, it, expect } from "vitest";
import scenario, { AgentAdapter, AgentRole } from "@langwatch/scenario";

const setId = "realtime-voice-agent-test-multimodal";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

function getFixtureAudioPath(): string {
  return path.join(__dirname, "fixtures", "sample.wav");
}

function toBase64(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data.toString("base64"));
    });
  });
}

// Voice agent powered by gpt-4o-audio-preview
const voiceAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    const audioPath = getFixtureAudioPath();
    const base64Audio = await toBase64(audioPath);

    const response = await openai.chat.completions.create({
      model: "gpt-4o-audio-preview",
      modalities: ["text", "audio"],
      audio: { format: "wav", voice: "alloy" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Please summarize what the speaker is saying in this audio recording." },
            { type: "input_audio", input_audio: { data: base64Audio, format: "wav" } },
          ],
        },
      ],
      store: false,
    });

    const reply = response.choices[0].message?.audio?.transcript;
    return reply || "(No response)";
  },
};

describe("Voice Agent Audio Tests (with gpt-4o preview)", () => {
  it("should transcribe and respond to audio", async () => {
    const result = await scenario.run({
      name: "voice agent: gpt-4o-audio-preview",
      description: "Send audio directly to gpt-4o-audio-preview and evaluate agent response",
      agents: [
        voiceAgent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          criteria: [
            "Agent responds clearly to the audio message",
            "Agent tone is conversational and helpful",
          ],
        }),
      ],
      script: [
        scenario.message({
          role: "user",
          content: `Please summarize what the person is saying in this recording`,
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
