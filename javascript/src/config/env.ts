import { z } from "zod/v4";
import { LogLevel } from "./log-levels";

const TRUE_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_FLAG_VALUES = new Set(["", "0", "false", "no", "off"]);

/** SCENARIO_SEND_GRANULAR_EVENTS read strictly; never `Boolean("false")`. */
const sendGranularEventsFlag = z
  .string()
  .optional()
  .transform((val, ctx) => {
    const normalised = (val ?? "").trim().toLowerCase();
    if (TRUE_FLAG_VALUES.has(normalised)) return true;
    if (FALSE_FLAG_VALUES.has(normalised)) return false;
    ctx.addIssue({
      code: "custom",
      message: `SCENARIO_SEND_GRANULAR_EVENTS must be one of true/false, 1/0, yes/no, on/off; got "${val}"`,
    });
    return z.NEVER;
  });

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
   * LangWatch project ID. When set alongside LANGWATCH_API_KEY, requests are
   * scoped to this project via the X-Project-Id header. Required for API keys
   * that are not bound to a single project.
   */
  LANGWATCH_PROJECT_ID: z.string().optional(),

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

  /**
   * Reports each message as TEXT_MESSAGE_START/END (plus live deltas from a
   * streaming agent) instead of a full MESSAGE_SNAPSHOT after every message.
   * `RunOptions.sendGranularEvents` wins when a run sets it. Read strictly:
   * "1", "true", "yes", "on" turn it on; "0", "false", "no", "off" or empty
   * leave it off; anything else is a configuration error, raised by
   * {@link resolveSendGranularEvents} only when the run does not decide.
   */
  SCENARIO_SEND_GRANULAR_EVENTS: z.string().optional(),
});

/**
 * Type definition for the validated environment variables.
 * Useful for type checking in other parts of the application.
 */
export type Env = z.infer<typeof envSchema>;

/**
 * Whether a run reports granular message events: the run's own option when
 * set, else SCENARIO_SEND_GRANULAR_EVENTS read strictly, else off. Throws
 * for a value that is neither on nor off.
 */
export function resolveSendGranularEvents(option: boolean | undefined): boolean {
  if (option !== undefined) return option;
  return sendGranularEventsFlag.parse(process.env.SCENARIO_SEND_GRANULAR_EVENTS);
}

/**
 * Get the environment variables.
 * This is a wrapper around the envSchema.parse function that ensures type safety and provides defaults where appropriate.
 */
export function getEnv(): Env {
  return envSchema.parse(process.env);
}
