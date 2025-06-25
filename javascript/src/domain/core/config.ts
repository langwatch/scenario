import { LanguageModel } from "ai";
import { z } from "zod";

/** Default temperature for language model inference */
export const DEFAULT_TEMPERATURE = 0.0;

/** Default LangWatch endpoint URL */
export const DEFAULT_LANGWATCH_ENDPOINT = "https://app.langwatch.ai";

export const scenarioProjectConfigSchema = z
  .object({
    defaultModel: z
      .object({
        model: z.custom<LanguageModel>(),
        temperature: z
          .number()
          .min(0.0)
          .max(1.0)
          .optional()
          .default(DEFAULT_TEMPERATURE),
        maxTokens: z.number().optional(),
      })
      .optional(),

    langwatchEndpoint: z.string().optional(),
    langwatchApiKey: z.string().optional(),
  })
  .strict();

export type ScenarioProjectConfig = z.infer<typeof scenarioProjectConfigSchema>;

export function defineConfig(
  config: ScenarioProjectConfig
): ScenarioProjectConfig {
  return config;
}
