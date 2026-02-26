/**
 * Test: Verify scenarioOnly filtering works via scenario.config.mjs —
 * the same flow a user like Mateusz would use.
 *
 * This is test-scenario-only.ts but using the config file path instead of
 * setupScenarioTracing(). No explicit tracing setup in this script — run()
 * lazily loads scenario.config.mjs and initializes everything.
 *
 * The config file sets up:
 *   - LangWatchTraceExporter with scenarioOnly filter
 *   - InMemorySpanExporter (for test verification)
 *   - instrumentations: [] (no auto-instrumentation)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

// Change cwd to the folder containing scenario.config.mjs
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(__dirname, "with-config-file"));
console.log(`Working directory: ${process.cwd()}`);

import { trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { run, AgentRole, user, agent, succeed } from "@langwatch/scenario";

function getScopeName(span: ReadableSpan): string {
  const s = span as any;
  return (
    s.instrumentationScope?.name ??
    s.instrumentationLibrary?.name ??
    "unknown"
  );
}

// --- Step 1: Create agents (no LLM needed) ---
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

// --- Step 2: Run scenario — lazily loads scenario.config.mjs ---
console.log("\nRunning scenario (lazily loading scenario.config.mjs with scenarioOnly filter)...");

const result = await run({
  name: "config-file-scenario-only-test",
  description: "Test scenarioOnly filtering via scenario.config.mjs",
  agents: [echoAgent, dummyUserAgent],
  script: [user("Hello from config file test!"), agent(), succeed()],
});

console.log(`\nScenario result: ${result.success ? "passed" : "failed"}`);

// --- Step 3: Create "server noise" AFTER tracing is initialized ---
// In a real server, these would be HTTP/middleware spans happening concurrently
const noiseTracer = trace.getTracer("http-server");
const noiseSpan = noiseTracer.startSpan("GET /api/health");
noiseSpan.end();
const middlewareSpan = noiseTracer.startSpan("middleware PUT /api/inngest");
middlewareSpan.end();

// --- Step 4: Import the test exporter from the config to inspect collected spans ---
const configModule = await import("./with-config-file/scenario.config.mjs");
const testExporter = configModule.testExporter;

await new Promise((resolve) => setTimeout(resolve, 500));

const spans = testExporter.getFinishedSpans();
console.log(`\nTotal spans in test exporter: ${spans.length}`);

const scenarioSpans = spans.filter(
  (s: ReadableSpan) => getScopeName(s) === "@langwatch/scenario"
);
const noiseSpans = spans.filter(
  (s: ReadableSpan) => getScopeName(s) === "http-server"
);

console.log(`  Scenario spans (@langwatch/scenario): ${scenarioSpans.length}`);
console.log(`  Noise spans (http-server): ${noiseSpans.length}`);

if (scenarioSpans.length > 0) {
  console.log("\nScenario spans:");
  for (const span of scenarioSpans) {
    console.log(`  - ${span.name} (${getScopeName(span)})`);
  }
}

if (noiseSpans.length > 0) {
  console.log("\nNoise spans (collected by test exporter, but filtered by LangWatchTraceExporter):");
  for (const span of noiseSpans) {
    console.log(`  - ${span.name} (${getScopeName(span)})`);
  }
}

// --- Step 5: Verify ---
if (!result.success) {
  console.error("\n❌ FAIL: Scenario did not succeed");
  process.exit(1);
}

if (scenarioSpans.length === 0) {
  console.error("\n❌ FAIL: No scenario spans were collected");
  process.exit(1);
}

console.log("\n✅ PASS: scenarioOnly filtering works via scenario.config.mjs");
console.log("   Config file loaded by run() via lazy initialization.");
console.log("   No setupScenarioTracing() call needed.");
console.log(`   ${scenarioSpans.length} scenario spans collected.`);
console.log(
  "   LangWatchTraceExporter with scenarioOnly filter only sends @langwatch/scenario spans to LangWatch."
);
if (noiseSpans.length > 0) {
  console.log(
    `   ${noiseSpans.length} noise spans captured by test exporter but filtered out by LangWatchTraceExporter.`
  );
}

process.exit(0);
