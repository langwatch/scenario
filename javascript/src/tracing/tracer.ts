import { getLangWatchTracer } from "langwatch";
import { LangWatchTracer } from "langwatch/observability";
import { setupObservability } from "langwatch/observability/node";
import { getEnv } from "../config";
import { Logger } from "../utils/logger";

const logger = new Logger("tracing.tracer");

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
export const tracer: LangWatchTracer = getLangWatchTracer(
  "@langwatch/scenario"
);

process.on("SIGTERM", async () => {
  const isEnabled = envConfig.LANGWATCH_API_KEY && envConfig.LANGWATCH_ENDPOINT;

  if (isEnabled) {
    logger.debug("Shutting down observability...");
    await observabilityHandle.shutdown();
    logger.debug("Observability shutdown complete");
    process.exit(0);
  }
});
