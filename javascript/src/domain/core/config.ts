import { LanguageModel } from "ai";
import { z } from "zod/v4";

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
    headless: z
      .boolean()
      .optional()
      .default(
        typeof process !== "undefined"
          ? !["false", "0"].includes(process.env.SCENARIO_HEADLESS || "false")
          : false
      ),
  })
  .strict();

export type ScenarioProjectConfig = z.infer<typeof scenarioProjectConfigSchema>;

export function defineConfig(
  config: ScenarioProjectConfig
): ScenarioProjectConfig {
  return config;
}
