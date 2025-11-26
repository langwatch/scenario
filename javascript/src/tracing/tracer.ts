import { getLangWatchTracer } from "langwatch";
import { setupObservability } from "langwatch/observability/node";
import { getEnv } from "../config";

/**
 * Sets up LangWatch observability for scenario testing.
 * Single responsibility: Initialize tracing infrastructure once per process.
 */
const envConfig = getEnv();

export const observabilityHandle = setupObservability({
  serviceName: "@langwatch/scenario",
  langwatch: {
    apiKey: envConfig.LANGWATCH_API_KEY,
    endpoint: envConfig.LANGWATCH_ENDPOINT,
  },
  dataCapture: "all",
});

/**
 * Shared tracer instance for all scenario operations.
 * Ensures consistent trace context across the application.
 */
export const tracer = getLangWatchTracer("@langwatch/scenario");
