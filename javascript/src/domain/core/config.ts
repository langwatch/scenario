import { z } from "zod/v4";
import { modelSchema } from "./schemas/model.schema";

const headless =
  typeof process !== "undefined"
    ? process.env.SCENARIO_HEADLESS === "true"
    : false;

export const scenarioProjectConfigSchema = z
  .object({
    defaultModel: modelSchema.optional(),
    headless: z.boolean().optional().default(headless),
  })
  .strict();

export type ScenarioProjectConfig = z.infer<typeof scenarioProjectConfigSchema>;

export function defineConfig(
  config: ScenarioProjectConfig
): ScenarioProjectConfig {
  return config;
}
