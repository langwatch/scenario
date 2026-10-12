// SDK setup and the two scenarios, the twin of go/fake/run.go.
import { importDependency, importSdk } from "./paths.mjs";
import {
  Criterion,
  Description,
  FakeBrain,
  MaxTurns,
  UserText,
  makeEchoAgent,
  makeOrderAgent,
} from "./fake-model.mjs";

// Same environment as the Go programs get from run.sh; set here too so a
// script started by hand behaves the same.
process.env.SCENARIO_BROWSER ??= "never";
process.env.SCENARIO_HEADLESS ??= "1";
process.env.SCENARIO_DISABLE_SIMULATION_REPORT_INFO ??= "1";
process.env.LOG_LEVEL ??= "error";

/**
 * Loads the SDK and sets up tracing once: the judge span collector, plus an
 * InMemorySpanExporter (the SDK puts traceExporter behind a
 * SimpleSpanProcessor), no LangWatch exporter and no auto-instrumentation.
 */
export async function setup({ needAi = false } = {}) {
  const sdk = await importSdk();
  const otel = await importDependency("@opentelemetry/sdk-trace-base");
  const ai = needAi ? await importDependency("ai") : undefined;
  const exporter = new otel.InMemorySpanExporter();
  sdk.setupScenarioTracing({
    langwatch: "disabled",
    traceExporter: exporter,
    instrumentations: [],
  });
  return { sdk, ai, exporter };
}

let batchSeq = 0;

/**
 * Runs the full scenario once (ten turns of user simulator, agent and
 * judge), posting events to sinkUrl, and returns the number of messages.
 */
export async function runFull(env, mode, sinkUrl) {
  const { sdk, ai } = env;
  const brain = new FakeBrain();
  const user = sdk.userSimulatorAgent({ model: brain.languageModel() });
  const judge = sdk.judgeAgent({ model: brain.languageModel(), criteria: [Criterion] });
  if (mode === "direct") {
    user.invokeLLM = brain.invokeLLM();
    judge.invokeLLM = brain.invokeLLM();
  }
  const result = await sdk.run(
    {
      name: "go-vs-js full scenario",
      description: Description,
      maxTurns: MaxTurns,
      setId: "go-vs-js",
      agents: [makeOrderAgent(sdk, ai, brain, mode), user, judge],
    },
    {
      batchRunId: `batch_go_vs_js_${++batchSeq}`,
      ...(sinkUrl ? { langwatch: { endpoint: sinkUrl, apiKey: "sk-lw-bench" } } : {}),
    }
  );
  if (!result.success) {
    throw new Error(`scenario did not pass: ${result.reasoning}`);
  }
  return result.messages.length;
}

/** The cold start scenario: one user message, one fixed answer, success. */
export async function runTrivial(env) {
  const { sdk } = env;
  const result = await sdk.run({
    name: "go-vs-js cold start",
    description: Description,
    agents: [makeEchoAgent(sdk)],
    script: [sdk.user(UserText), sdk.agent(), sdk.succeed("done")],
  });
  if (!result.success || result.messages.length !== 2) {
    throw new Error(`cold start scenario: success=${result.success} messages=${result.messages.length}`);
  }
}
