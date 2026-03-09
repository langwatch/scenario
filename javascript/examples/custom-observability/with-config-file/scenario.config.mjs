/**
 * Example scenario.config.mjs demonstrating the scenarioOnly filter.
 *
 * This is what a user like Mateusz would put in their project root.
 * When run() is called, it lazily loads this config and initializes
 * tracing with these options — no setupScenarioTracing() call needed.
 *
 * We also export the testExporter so the test script can inspect
 * which spans were collected.
 */
import { defineConfig, scenarioOnly } from "@langwatch/scenario";
import {
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { LangWatchTraceExporter } from "langwatch/observability";

// A test exporter to verify which spans the LangWatchTraceExporter would send.
// In production, users would just use LangWatchTraceExporter directly.
export const testExporter = new InMemorySpanExporter();

export default defineConfig({
  observability: {
    // The LangWatch exporter with scenarioOnly filter —
    // only @langwatch/scenario spans get sent to LangWatch
    traceExporter: new LangWatchTraceExporter({
      filters: scenarioOnly,
    }),
    // Extra processor for test verification
    spanProcessors: [new SimpleSpanProcessor(testExporter)],
    // Disable auto-instrumentation of HTTP, middleware, etc.
    instrumentations: [],
  },
});
