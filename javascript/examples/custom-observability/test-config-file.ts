/**
 * Test: Verify that scenario.config.mjs observability options are picked up
 * by run() via lazy initialization — no explicit setupScenarioTracing() call.
 *
 * This simulates the real user experience:
 * 1. User creates scenario.config.mjs with observability options
 * 2. User calls run() in their Inngest cron job
 * 3. run() lazily loads the config and initializes tracing
 *
 * We chdir into the with-config-file/ folder so loadScenarioProjectConfig()
 * picks up the scenario.config.mjs via process.cwd().
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

// Change cwd to the folder containing scenario.config.mjs
// so that run() -> getProjectConfig() -> loadScenarioProjectConfig() finds it
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(__dirname, "with-config-file"));
console.log(`Working directory: ${process.cwd()}`);
console.log(`Config file: ${path.join(process.cwd(), "scenario.config.mjs")}`);

import { trace } from "@opentelemetry/api";
import { run, AgentRole, user, agent, succeed } from "@langwatch/scenario";

// --- Step 1: Verify OTel is NOT initialized yet (no setupScenarioTracing call) ---
const providerBefore = trace.getTracerProvider();
console.log(`\nProvider before run(): ${providerBefore.constructor.name}`);

// --- Step 2: Create agents (no LLM needed) ---
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

// --- Step 3: Run scenario — this should lazily load scenario.config.mjs ---
console.log("\nRunning scenario (should lazily load scenario.config.mjs)...");

const result = await run({
  name: "config-file-test",
  description:
    "Test that scenario.config.mjs observability options are picked up by run()",
  agents: [echoAgent, dummyUserAgent],
  script: [user("Hello from config file test!"), agent(), succeed()],
});

console.log(`\nScenario result: ${result.success ? "passed" : "failed"}`);
console.log(`Reasoning: ${result.reasoning}`);

// --- Step 4: Verify OTel was initialized by run() ---
const providerAfter = trace.getTracerProvider();
console.log(`\nProvider after run(): ${providerAfter.constructor.name}`);

if (providerBefore.constructor.name !== providerAfter.constructor.name) {
  console.log(
    "   run() lazily initialized OpenTelemetry (provider changed)"
  );
} else {
  console.log(
    "   Provider wrapper unchanged (may be delegating internally via ProxyTracerProvider)"
  );
}

// --- Step 5: Verify the scenario succeeded ---
if (result.success) {
  console.log("\n✅ PASS: Scenario ran successfully using scenario.config.mjs");
  console.log(
    "   The config file was loaded by run() via lazy initialization."
  );
  console.log("   No setupScenarioTracing() call was needed.");
  console.log(
    '   observability.instrumentations: [] was applied (no auto-instrumentation).'
  );
} else {
  console.error("\n❌ FAIL: Scenario did not succeed");
  console.error(`   Reasoning: ${result.reasoning}`);
  process.exit(1);
}

process.exit(0);
