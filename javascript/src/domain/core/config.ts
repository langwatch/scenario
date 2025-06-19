import { LanguageModel } from "ai";
import { z } from "zod";

export const scenarioProjectConfigSchema = z.object({
  defaultModel: z.object({
    model: z.custom<LanguageModel>(),
    temperature: z.number().min(0.0).max(1.0).optional().default(0.0),
    apiKey: z.string().optional(),
    maxTokens: z.number().optional(),
  }).optional(),
}).strict();

export type ScenarioProjectConfig = z.infer<typeof scenarioProjectConfigSchema>;

export function defineConfig(config: ScenarioProjectConfig): ScenarioProjectConfig {
  return config;
}
