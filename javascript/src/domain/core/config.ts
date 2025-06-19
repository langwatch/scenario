import { LanguageModel } from "ai";
import { z } from "zod";

export const scenarioProjectConfigSchema = z.object({
  defaultModel: z.object({
    model: z.custom<LanguageModel>(),
    temperature: z.number().min(0.0).max(1.0).optional().default(0.0),
    maxTokens: z.number().optional(),
  }).optional(),

  langwatchEndpoint: z.string().default(process.env.LANGWATCH_ENDPOINT ?? "https://app.langwatch.ai"),
  langwatchApiKey: z.string().default(process.env.LANGWATCH_API_KEY ?? "").optional(),
}).strict();

export type ScenarioProjectConfig = z.infer<typeof scenarioProjectConfigSchema>;

export function defineConfig(config: ScenarioProjectConfig): ScenarioProjectConfig {
  return config;
}
