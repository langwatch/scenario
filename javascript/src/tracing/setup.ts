import { setupObservability } from "langwatch/observability/node";
import { getEnv } from "../config";

/**
 * Sets up LangWatch observability for scenario testing.
 * Single responsibility: Initialize tracing infrastructure once per process.
 */
const envConfig = getEnv();

export const observabilityHandle = setupObservability({
  langwatch: {
    apiKey: envConfig.LANGWATCH_API_KEY,
    endpoint: envConfig.LANGWATCH_ENDPOINT,
  },
});
