import { LanguageModel } from "ai";
import { z } from "zod/v4";
import { DEFAULT_TEMPERATURE } from "../constants";

/**
 * Schema for a language model.
 */
export const modelSchema = z.object({
  model: z
    .custom<LanguageModel>((val) => Boolean(val), {
      message:
        "A model is required. Configure it in scenario.config.js defaultModel or pass directly to the agent.",
    })
    .describe("Language model that is used by the AI SDK Core functions."),
  temperature: z
    .number()
    .min(0.0)
    .max(1.0)
    .optional()
    .describe("The temperature for the language model.")
    .default(DEFAULT_TEMPERATURE),
  maxTokens: z
    .number()
    .optional()
    .describe("The maximum number of tokens to generate."),
});

export type ModelConfig = z.infer<typeof modelSchema>;
