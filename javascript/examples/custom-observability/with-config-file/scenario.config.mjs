/**
 * Example scenario.config.mjs demonstrating the observability configuration.
 *
 * This is what a user like Mateusz would put in their project root.
 * When run() is called, it lazily loads this config and initializes
 * tracing with these options — no setupScenarioTracing() call needed.
 */
import { defineConfig, scenarioOnly } from "@langwatch/scenario";

export default defineConfig({
  observability: {
    // Disable auto-instrumentation of HTTP, middleware, etc.
    instrumentations: [],
  },
  headless: true,
});
