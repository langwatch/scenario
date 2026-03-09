/**
 * Test: Verify withCustomScopes() -- capture scenario spans + custom tagged spans.
 *
 * Demonstrates the advanced use case where a user wants to include their own
 * instrumented code (e.g., database calls) alongside scenario spans.
 */
import { trace } from "@opentelemetry/api";
import {
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  run,
  AgentRole,
  user,
  agent,
  succeed,
  setupScenarioTracing,
  withCustomScopes,
} from "@langwatch/scenario";

/**
 * Returns the instrumentation scope name for a span, handling both
 * OTel SDK v1 (instrumentationLibrary) and v2 (instrumentationScope).
 */
function getScopeName(span: ReadableSpan): string {
  const s = span as any;
  return (
    s.instrumentationScope?.name ??
    s.instrumentationLibrary?.name ??
    "unknown"
  );
}

// --- Step 1: Set up span collection ---
const memoryExporter = new InMemorySpanExporter();
const collectorProcessor = new SimpleSpanProcessor(memoryExporter);

setupScenarioTracing({
  instrumentations: [],
  spanProcessors: [collectorProcessor],
  langwatch: "disabled" as any,
});

// --- Step 2: Create a "database" tracer under a custom scope ---
const dbTracer = trace.getTracer("my-app/database");
const httpTracer = trace.getTracer("http-server");

// Simulate a database-backed agent
const dbAgent = {
  role: AgentRole.AGENT as const,
  call: async (input: any) => {
    // Simulate a database query (tagged with custom scope)
    return dbTracer.startActiveSpan(
      "db.query SELECT users",
      async (dbSpan) => {
        try {
          // Simulate some work
          await new Promise((resolve) => setTimeout(resolve, 10));
          dbSpan.setAttribute(
            "db.statement",
            "SELECT * FROM users WHERE id = ?"
          );
          dbSpan.setAttribute("db.system", "postgresql");
          return "Found user: Alice (from database)";
        } finally {
          dbSpan.end();
        }
      }
    );
  },
};

// A dummy user agent is required by the framework for the user() script step,
// even though the content is provided inline (the agent's call() is never invoked).
const dummyUserAgent = {
  role: AgentRole.USER as const,
  call: async () => "unused",
};

// --- Step 3: Create HTTP noise (should be excluded) ---
const httpSpan = httpTracer.startSpan("GET /api/health");
httpSpan.end();

// --- Step 4: Run scenario ---
console.log("Running scenario with database-backed agent...");

const result = await run({
  name: "custom-scopes-test",
  description: "Test that custom scopes are captured alongside scenario spans",
  agents: [dbAgent, dummyUserAgent],
  script: [user("Look up user Alice"), agent(), succeed()],
});

console.log(`\nScenario result: ${result.success ? "passed" : "failed"}`);

// --- Step 5: Inspect spans by scope ---
await new Promise((resolve) => setTimeout(resolve, 500));
await collectorProcessor.forceFlush();

const spans = memoryExporter.getFinishedSpans();
const byScope = new Map<string, typeof spans>();
for (const span of spans) {
  const scope = getScopeName(span);
  if (!byScope.has(scope)) byScope.set(scope, []);
  byScope.get(scope)!.push(span);
}

console.log(`\nTotal spans: ${spans.length}`);
console.log("\nSpans by instrumentation scope:");
for (const [scope, scopeSpans] of byScope) {
  console.log(`\n  ${scope} (${scopeSpans.length} spans):`);
  for (const span of scopeSpans) {
    const attrs = Object.entries(span.attributes)
      .filter(([k]) => k.startsWith("db."))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(`    - ${span.name}${attrs ? ` [${attrs}]` : ""}`);
  }
}

// --- Step 6: Show what withCustomScopes would filter ---
const filters = withCustomScopes("my-app/database");
console.log("\n--- Filter config for LangWatchTraceExporter ---");
console.log('withCustomScopes("my-app/database") would include:');
console.log(
  `  @langwatch/scenario spans (${byScope.get("@langwatch/scenario")?.length ?? 0})`
);
console.log(
  `  my-app/database spans (${byScope.get("my-app/database")?.length ?? 0})`
);
console.log(
  `  http-server spans (${byScope.get("http-server")?.length ?? 0}) -- filtered out`
);

const scenarioCount = byScope.get("@langwatch/scenario")?.length ?? 0;
const dbCount = byScope.get("my-app/database")?.length ?? 0;

if (scenarioCount > 0 && dbCount > 0) {
  console.log("\nPASS: Both scenario and custom-scoped spans are captured");
  console.log(
    "   Database spans appear alongside scenario spans for debugging."
  );
} else {
  console.error("\nFAIL: Expected both scenario and database spans");
  console.error(
    `   Scenario spans: ${scenarioCount}, Database spans: ${dbCount}`
  );
  process.exit(1);
}

process.exit(0);
