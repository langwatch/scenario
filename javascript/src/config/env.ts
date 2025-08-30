import { z } from "zod/v4";
import { LogLevel } from "./log-levels";

/**
 * Schema for environment variables used by the scenario package.
 * Provides validation and type safety for environment configuration.
 */
const envSchema = z.object({
  /**
   * LangWatch API key for event reporting.
   * If not provided, events will not be sent to LangWatch.
   */
  LANGWATCH_API_KEY: z.string().optional(),

  /**
   * LangWatch endpoint URL for event reporting.
   * Defaults to the production LangWatch endpoint.
   */
  LANGWATCH_ENDPOINT: z
    .string()
    .url()
    .optional()
    .default("https://app.langwatch.ai"),

  /**
   * Disables simulation report info messages when set to any truthy value.
   * Useful for CI/CD environments or when you want cleaner output.
   */
  SCENARIO_DISABLE_SIMULATION_REPORT_INFO: z
    .string()
    .optional()
    .transform((val) => Boolean(val)),

  /**
   * Node environment - affects logging and behavior.
   * Defaults to 'development' if not specified.
   */
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  /**
   * Case-insensitive log level for the scenario package.
   * Defaults to 'info' if not specified.
   */
  LOG_LEVEL: z
    .string()
    .toUpperCase()
    .pipe(z.nativeEnum(LogLevel))
    .optional()
    .default(LogLevel.INFO),

  /**
   * Scenario batch run ID.
   * If not provided, a random ID will be generated.
   */
  SCENARIO_BATCH_RUN_ID: z.string().optional(),
});

/**
 * Type definition for the validated environment variables.
 * Useful for type checking in other parts of the application.
 */
export type Env = z.infer<typeof envSchema>;

/**
 * Get the environment variables.
 * This is a wrapper around the envSchema.parse function that ensures type safety and provides defaults where appropriate.
 */
export function getEnv(): Env {
  return envSchema.parse(process.env);
}
