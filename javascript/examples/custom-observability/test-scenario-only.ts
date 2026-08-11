/**
 * Test: Verify scenarioOnly filter works -- only @langwatch/scenario spans are exported.
 *
 * This simulates the production use case: a server process that imports scenario
 * and only wants scenario-scoped spans, not HTTP/middleware noise.
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
  scenarioOnly,
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

// --- Step 1: Set up a custom InMemorySpanExporter to capture what gets collected ---
const memoryExporter = new InMemorySpanExporter();
const collectorProcessor = new SimpleSpanProcessor(memoryExporter);

// --- Step 2: Initialize scenario tracing with custom config ---
setupScenarioTracing({
  instrumentations: [], // disable auto-instrumentation
  spanProcessors: [collectorProcessor],
  langwatch: "disabled" as any, // don't send to LangWatch for this test
});

// --- Step 3: Simulate "server noise" -- create spans that should be filtered out ---
const noiseTracer = trace.getTracer("http-server");
const noiseSpan = noiseTracer.startSpan("GET /api/health");
noiseSpan.end();
const middlewareSpan = noiseTracer.startSpan("middleware PUT /api/inngest");
middlewareSpan.end();

// --- Step 4: Run a minimal scenario (no LLM needed) ---
// A dummy user agent is required by the framework for the user() script step,
// even though the content is provided inline (the agent's call() is never invoked).
const dummyUserAgent = {
  role: AgentRole.USER as const,
  call: async () => "unused",
};

const echoAgent = {
  role: AgentRole.AGENT as const,
  call: async (input: any) => {
    const lastMessage = input.messages.at(-1);
    const content =
      typeof lastMessage?.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage?.content);
    return `Echo: ${content}`;
  },
};

console.log("Running scenario with echo agent...");

const result = await run({
  name: "observability-test",
  description: "Test that scenarioOnly filtering works",
  agents: [echoAgent, dummyUserAgent],
  script: [user("Hello, can you hear me?"), agent(), succeed()],
});

console.log(`\nScenario result: ${result.success ? "passed" : "failed"}`);
console.log(`Reasoning: ${result.reasoning}`);

// --- Step 5: Inspect collected spans ---
// Give the processor a moment to flush
await new Promise((resolve) => setTimeout(resolve, 500));
await collectorProcessor.forceFlush();

const spans = memoryExporter.getFinishedSpans();
console.log(`\nTotal spans collected: ${spans.length}`);

const scenarioSpans = spans.filter(
  (s) => getScopeName(s) === "@langwatch/scenario"
);
const noiseSpans = spans.filter((s) => getScopeName(s) === "http-server");
const otherSpans = spans.filter(
  (s) =>
    getScopeName(s) !== "@langwatch/scenario" &&
    getScopeName(s) !== "http-server"
);

console.log(
  `  Scenario spans (@langwatch/scenario): ${scenarioSpans.length}`
);
console.log(`  Noise spans (http-server): ${noiseSpans.length}`);
console.log(`  Other spans: ${otherSpans.length}`);

if (scenarioSpans.length > 0) {
  console.log("\nScenario spans:");
  for (const span of scenarioSpans) {
    console.log(`  - ${span.name} (${getScopeName(span)})`);
  }
}

if (noiseSpans.length > 0) {
  console.log(
    "\nNoise spans (these are collected but would be filtered by LangWatchTraceExporter):"
  );
  for (const span of noiseSpans) {
    console.log(`  - ${span.name} (${getScopeName(span)})`);
  }
}

// Note: the scenarioOnly filter works at the EXPORTER level (LangWatchTraceExporter),
// not at the span processor level. Since we're using InMemorySpanExporter with a
// SimpleSpanProcessor, ALL spans get collected. The filtering happens when spans
// are exported to LangWatch. This test verifies that scenario spans ARE created
// and the noise spans are separate -- the LangWatchTraceExporter would filter them.

if (!result.success) {
  console.error(`\nFAIL: Scenario did not succeed: ${result.reasoning}`);
  process.exit(1);
}

if (scenarioSpans.length === 0) {
  console.error("\nFAIL: No @langwatch/scenario spans were collected");
  process.exit(1);
}

// The two spans created at step 3 must survive to here. If they do not, the
// collector is dropping spans and "no noise reached the exporter" would be true
// for a reason that has nothing to do with filtering.
if (noiseSpans.length !== 2) {
  console.error(
    `\nFAIL: expected the 2 http-server noise spans to be collected, found ${noiseSpans.length}`
  );
  process.exit(1);
}

// The exporter is not reachable from here, so the closest observable claim is
// that the scope scenarioOnly selects on is the scope the scenario spans are
// actually emitted under. Renaming the instrumentation scope would silently
// turn the filter into a drop-everything rule, and only this binding catches it.
const scenarioOnlyScopes = scenarioOnly.flatMap((filter) =>
  "include" in filter
    ? (filter.include.instrumentationScopeName ?? []).flatMap((match) =>
        match.equals ? [match.equals] : []
      )
    : []
);

const unselected = scenarioSpans.filter(
  (span) => !scenarioOnlyScopes.includes(getScopeName(span))
);

if (unselected.length > 0) {
  console.error(
    `\nFAIL: scenarioOnly selects ${JSON.stringify(scenarioOnlyScopes)}, but ` +
      `${unselected.length} scenario span(s) are emitted under ` +
      `${JSON.stringify([...new Set(unselected.map(getScopeName))])}`
  );
  process.exit(1);
}

if (scenarioOnlyScopes.some((scope) => noiseSpans.some((span) => getScopeName(span) === scope))) {
  console.error(
    "\nFAIL: scenarioOnly also selects the http-server noise scope, so it would not filter it out"
  );
  process.exit(1);
}

console.log(
  "\nPASS: Scenario runs correctly with custom observability config"
);
console.log("   Scenario spans are created under @langwatch/scenario scope.");
console.log("   Server noise spans are under separate scopes (http-server).");
console.log(
  "   LangWatchTraceExporter with scenarioOnly filter would only export scenario spans."
);

process.exit(0);
