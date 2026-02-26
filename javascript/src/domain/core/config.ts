import { z } from "zod/v4";
import type { SetupObservabilityOptions } from "langwatch/observability/node";
import { modelSchema } from "./schemas/model.schema";

const headless =
  typeof process !== "undefined"
    ? process.env.SCENARIO_HEADLESS === "true"
    : false;

/**
 * Schema for the scenario project configuration file (scenario.config.js).
 *
 * The `observability` field accepts a subset of `SetupObservabilityOptions`
 * from the langwatch SDK. It uses `z.custom()` to avoid strict validation
 * on the passthrough object while keeping the outer config strict.
 */
export const scenarioProjectConfigSchema = z
  .object({
    defaultModel: modelSchema.optional(),
    headless: z.boolean().optional().default(headless),
    observability: z
      .custom<Partial<SetupObservabilityOptions>>((val) => {
        return val === undefined || (typeof val === "object" && val !== null && !Array.isArray(val));
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
