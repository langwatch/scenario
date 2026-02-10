import * as fs from "fs";
import * as path from "path";
import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, UserModelMessage } from "ai";
import { describe, it, expect } from "vitest";

// Use setId to group together for visualizing in the UI
const setId = "multimodal-images-test";

// Helper function to encode image to base64
function encodeImageToBase64(filePath: string): string {
  const imageBuffer = fs.readFileSync(filePath);
  return imageBuffer.toString("base64");
}

// Helper function to create image data URL
function createImageDataURL(
  imagePath: string,
  mimeType: string = "image/webp"
): string {
  const base64Image = encodeImageToBase64(imagePath);
  return `data:${mimeType};base64,${base64Image}`;
}

// Get the fixture image path
function getFixtureImagePath(): string {
  return path.join(__dirname, "fixtures", "scenario.webp");
}

describe("Multimodal Images Tests", () => {
  // Create an agent that can handle image input
  const imageAgent: AgentAdapter = {
    role: AgentRole.AGENT,
    call: async (input) => {
      const response = await generateText({
        model: openai("gpt-4o"),
        messages: [
          {
            role: "system",
            content: `
              You are a helpful assistant that can process both text and image input.
              When analyzing images, be descriptive and helpful.
              Respond naturally to user queries about images.
            `,
          },
          ...input.messages,
        ],
      });
      return response.text;
    },
  };

  it("should process text and image input together", async () => {
    // Use the actual fixture image
    const imageDataURL = createImageDataURL(getFixtureImagePath());

    const imageMessage = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "What do you see in this image?" },
        {
          type: "image" as const,
          image: imageDataURL,
        },
      ],
    } as UserModelMessage;

    const result = await scenario.run({
      name: "multimodal image analysis",
      description:
        "User sends both text and image, agent analyzes the image content",
      agents: [
        imageAgent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          criteria: [
            "Agent acknowledges the image input",
            "Agent provides a descriptive analysis of the image",
            "Agent responds appropriately to the text question",
            "Agent demonstrates understanding of the multimodal input",
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

    try {
      expect(result.success).toBe(true);
    } catch (error) {
      console.error(result);
      throw error;
    }
  });

  it("should handle image-only input", async () => {
    const imageDataURL = createImageDataURL(getFixtureImagePath());

    const imageOnlyMessage = {
      role: "user" as const,
      content: [
        {
          type: "image" as const,
          image: imageDataURL,
        },
      ],
    } as UserModelMessage;

    const result = await scenario.run({
      name: "image-only analysis",
      description: "User sends only an image, agent provides analysis",
      agents: [
        imageAgent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          criteria: [
            "Agent recognizes the image input",
            "Agent provides meaningful analysis without text prompt",
            "Agent demonstrates image understanding capabilities",
          ],
        }),
      ],
      script: [
        scenario.message(imageOnlyMessage),
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

  it("should handle complex multimodal queries", async () => {
    const imageDataURL = createImageDataURL(getFixtureImagePath());

    const complexMessage = {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: "Analyze this image and tell me what colors are present, what shapes you see, and what this might represent.",
        },
        {
          type: "image" as const,
          image: imageDataURL,
        },
      ],
    } as UserModelMessage;

    const result = await scenario.run({
      name: "complex image analysis",
      description: "User asks for detailed analysis of image elements",
      agents: [
        imageAgent,
        scenario.userSimulatorAgent(),
        scenario.judgeAgent({
          criteria: [
            "Agent identifies colors in the image",
            "Agent recognizes shapes present",
            "Agent provides interpretation of the image content",
            "Agent addresses all aspects of the complex query",
          ],
        }),
      ],
      script: [
        scenario.message(complexMessage),
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

  it.todo("should handle different image formats (JPEG, PNG, WebP)");
  it.todo("should handle large images gracefully");
  it.todo(
    "should provide appropriate responses for unclear or low-quality images"
  );
  it.todo("should handle multiple images in a single message");
});
