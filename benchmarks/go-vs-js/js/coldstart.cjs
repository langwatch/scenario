// Cold start, CommonJS: require the built SDK (dist/index.js), set up
// tracing, run the trivial scenario once, print the peak RSS, exit. Same
// steps as coldstart.mjs; kept self-contained so nothing ESM is loaded.
"use strict";

const path = require("node:path");
const { createRequire } = require("node:module");

process.env.SCENARIO_BROWSER ??= "never";
process.env.SCENARIO_HEADLESS ??= "1";
process.env.SCENARIO_DISABLE_SIMULATION_REPORT_INFO ??= "1";
process.env.LOG_LEVEL ??= "error";

const jsDir = process.env.SCENARIO_JS_DIR
  ? path.resolve(process.env.SCENARIO_JS_DIR)
  : path.resolve(__dirname, "..", "..", "..", "javascript");
const fromSdk = createRequire(path.join(jsDir, "package.json"));

// Same strings as lib/fake-model.mjs.
const UserText =
  "Hi, I ordered a blue kettle last week and it has not arrived yet. Where is order 42?";
const AgentText =
  "Your order 42 left our warehouse yesterday and should arrive within two days.";
const Description = "A customer asks the support agent where their order is.";

async function main() {
  const sdk = require(path.join(jsDir, "dist", "index.js"));
  const { InMemorySpanExporter } = fromSdk("@opentelemetry/sdk-trace-base");
  sdk.setupScenarioTracing({
    langwatch: "disabled",
    traceExporter: new InMemorySpanExporter(),
    instrumentations: [],
  });

  class EchoAgent extends sdk.AgentAdapter {
    role = sdk.AgentRole.AGENT;
    async call() {
      return AgentText;
    }
  }

  const result = await sdk.run({
    name: "go-vs-js cold start",
    description: Description,
    agents: [new EchoAgent()],
    script: [sdk.user(UserText), sdk.agent(), sdk.succeed("done")],
  });
  if (!result.success || result.messages.length !== 2) {
    throw new Error(`cold start scenario: success=${result.success} messages=${result.messages.length}`);
  }
  process.stdout.write(JSON.stringify({ maxrss_bytes: process.resourceUsage().maxRSS * 1024 }) + "\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
