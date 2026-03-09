/**
 * Test: Verify that importing @langwatch/scenario does NOT auto-initialize OpenTelemetry.
 *
 * Before this fix, just importing the module with LANGWATCH_API_KEY set would
 * trigger setupObservability() and instrument all HTTP requests, middleware, etc.
 */
import { trace } from "@opentelemetry/api";

// Check the provider BEFORE importing scenario
const providerBefore = trace.getTracerProvider();
const providerNameBefore = providerBefore.constructor.name;

// Dynamically import scenario to test the side-effect
const scenario = await import("@langwatch/scenario");

// Check the provider AFTER importing scenario
const providerAfter = trace.getTracerProvider();
const providerNameAfter = providerAfter.constructor.name;

console.log(`Provider before import: ${providerNameBefore}`);
console.log(`Provider after import:  ${providerNameAfter}`);

if (providerNameBefore === providerNameAfter) {
  console.log(
    "\nPASS: Importing @langwatch/scenario did NOT auto-initialize OpenTelemetry"
  );
  console.log("   The global TracerProvider is unchanged.");
} else {
  console.error(
    "\nFAIL: Importing @langwatch/scenario auto-initialized OpenTelemetry!"
  );
  console.error(
    `   Provider changed from ${providerNameBefore} to ${providerNameAfter}`
  );
  process.exit(1);
}
