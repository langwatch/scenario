import * as fs from "fs";
import * as path from "path";
import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, UserModelMessage } from "ai";
import { describe, it, expect } from "vitest";

const setId = "scenarios-github";

function getFixtureImagePath(): string {
  return path.join(__dirname, "fixtures", "scenario.webp");
}

function createImageDataURL(
  imagePath: string,
  mimeType: string = "image/webp"
): string {
  const imageBuffer = fs.readFileSync(imagePath);
  return `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
}

describe("Demo: Lightweight Scenarios", () => {
  const imageAgent: AgentAdapter = {
    role: AgentRole.AGENT,
    call: async (input) => {
      const response = await generateText({
        model: openai("gpt-5-mini"),
        messages: [
          {
            role: "system",
            content:
              "You can analyze images and respond briefly and helpfully.",
          },
          ...input.messages,
        ],
        experimental_telemetry: { isEnabled: true },
      });
      return response.text;
    },
  };

  it("image: describe the demo image", async () => {
    const imageDataURL = createImageDataURL(getFixtureImagePath());
    const imageMessage = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "What is shown here?" },
        { type: "image" as const, image: imageDataURL },
      ],
    } as UserModelMessage;

    const result = await scenario.run({
      name: "demo image description",
      description: "Simple image understanding check for demo runs",
      agents: [
        imageAgent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          criteria: [
            "Agent acknowledges the image",
            "Agent provides a short description",
          ],
        }),
      ],
      script: [
        scenario.message(imageMessage),
        scenario.agent(),
        scenario.judge(),
      ],
      setId,
    });

    expect(result.success).toBe(true);
  });

});
