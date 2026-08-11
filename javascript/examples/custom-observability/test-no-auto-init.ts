/**
 * Test: Verify that importing @langwatch/scenario does NOT auto-initialize OpenTelemetry.
 *
 * Before this fix, just importing the module with LANGWATCH_API_KEY set would
 * trigger setupObservability() and instrument all HTTP requests, middleware, etc.
 *
 * What this reads, and why it is not the provider itself: `trace.getTracerProvider()`
 * always hands back the SAME ProxyTracerProvider instance, registered or not. Comparing
 * that object, or its constructor name, before and after the import compares a value
 * that cannot change, so the check printed PASS even with the regression present.
 * Registration swaps the proxy's DELEGATE, from NoopTracerProvider to a real provider,
 * so the delegate is what carries the signal.
 */
import { trace } from "@opentelemetry/api";

/**
 * Name of the provider the global proxy currently delegates to.
 *
 * `getDelegate` is not on the public TracerProvider type. The fallback reports
 * the proxy itself on an API version that does not expose it, which makes the
 * start-state assertion below fail loudly rather than quietly comparing two
 * constants again.
 */
const delegateName = (): string => {
  const provider = trace.getTracerProvider() as { getDelegate?: () => object };
  return (provider.getDelegate ? provider.getDelegate() : provider).constructor
    .name;
};

// Check the provider BEFORE importing scenario
const delegateBefore = delegateName();

// Dynamically import scenario to test the side-effect
const scenario = await import("@langwatch/scenario");
void scenario;

// Check the provider AFTER importing scenario
const delegateAfter = delegateName();

console.log(`Provider before import: ${delegateBefore}`);
console.log(`Provider after import:  ${delegateAfter}`);

if (delegateBefore !== "NoopTracerProvider") {
  // Guards the guard. If anything registered a provider before this point, the
  // comparison below proves nothing, and a check that cannot fail is worse than
  // no check at all because it reads as coverage.
  console.error(
    `\nFAIL: expected no tracer provider registered at start, found ${delegateBefore}`
  );
  console.error("   From that starting state this test proves nothing.");
  process.exit(1);
}

if (delegateBefore === delegateAfter) {
  console.log(
    "\nPASS: Importing @langwatch/scenario did NOT auto-initialize OpenTelemetry"
  );
  console.log("   The global TracerProvider is unchanged.");
} else {
  console.error(
    "\nFAIL: Importing @langwatch/scenario auto-initialized OpenTelemetry!"
  );
  console.error(
    `   Provider changed from ${delegateBefore} to ${delegateAfter}`
  );
  process.exit(1);
}
