import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import { describe, it, expect } from "vitest";

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

describe("Voice Agent Audio Tests (multimodal)", () => {
  it("should respond to raw audio", async () => {
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
            { type: "text", text: "What is in this recording?" },
            { type: "input_audio", input_audio: { data: base64Audio, format: "wav" } },
          ],
        },
      ],
      store: false,
    });

    const transcript = response.choices[0].message?.audio?.transcript;

    console.log("Transcript:", transcript);

    expect(typeof transcript).toBe("string");
    expect(transcript?.length).toBeGreaterThan(0);
  });
});
