import { LanguageModel } from "ai";
import { z } from "zod";

/** Default temperature for language model inference */
export const DEFAULT_TEMPERATURE = 0.0;

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
  })
  .strict();

export type ScenarioProjectConfig = z.infer<typeof scenarioProjectConfigSchema>;

export function defineConfig(
  config: ScenarioProjectConfig
): ScenarioProjectConfig {
  return config;
}
