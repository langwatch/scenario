import { openai } from "@ai-sdk/openai";
import { defineConfig } from "@langwatch/scenario";

export default defineConfig({
  defaultModel: {
    model: openai("gpt-4.1-nano"),
  },
});
