import type { SetupObservabilityOptions } from "langwatch/observability/node";
import { z } from "zod/v4";
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
    /**
     * Project-wide default for `ScenarioConfig.fetchRemoteTraces`. A per-run
     * value on the scenario config wins over this default.
     */
    fetchRemoteTraces: z.boolean().optional(),
    /**
     * Project-wide default for `ScenarioConfig.traceWaitTimeoutMs`. A per-run
     * value on the scenario config wins over this default.
     */
    traceWaitTimeoutMs: z.number().positive().optional(),
    /**
     * Project-wide default for `ScenarioConfig.traceWaitExtensionMs`. A
     * per-run value on the scenario config wins over this default.
     */
    traceWaitExtensionMs: z.number().positive().optional(),
  })
  .strict();

export type ScenarioProjectConfig = z.infer<typeof scenarioProjectConfigSchema>;

export function defineConfig(
  config: ScenarioProjectConfig
): ScenarioProjectConfig {
  return config;
}
