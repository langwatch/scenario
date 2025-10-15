import { openai } from "@ai-sdk/openai";
import { defineConfig } from "@langwatch/scenario";

export default defineConfig({
  defaultModel: {
    model: openai("gpt-4.1"),
  },
  verbose: process.env.CI !== "true",
  headless: process.env.CI === "true",
});
