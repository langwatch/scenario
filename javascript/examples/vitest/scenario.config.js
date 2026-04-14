import { openai } from "@ai-sdk/openai";
import { defineConfig } from "@langwatch/scenario";

export default defineConfig({
  defaultModel: {
    model: openai("gpt-5-mini"),
  },
  headless: true,
});
