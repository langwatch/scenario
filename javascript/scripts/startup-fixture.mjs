import assert from "node:assert/strict";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const entry = process.argv[2];
const sdk = entry.endsWith(".mjs") ? await import(entry) : require(fileURLToPath(entry));
const loaded = (pattern) => Object.keys(require.cache).filter((path) => pattern.test(path));
assert.deepEqual(loaded(/[/\\]@opentelemetry[/\\]sdk-node[/\\]/), []);
assert.deepEqual(loaded(/[/\\]langwatch[/\\]dist[/\\]index\.js$/), []);
assert.deepEqual(loaded(/[/\\]open[/\\]index\.js$/), []);
assert.deepEqual(loaded(/[/\\]@elevenlabs[/\\]/), []);
assert.equal(sdk.default, sdk.scenario);
for (const name of ["run", "judgeAgent", "userSimulatorAgent", "configure", "evaluator",
  "pipecatAgent", "openAIRealtimeAgent", "geminiLiveAgent", "elevenLabsAgent",
  "twilioAgent", "composableAgent"]) {
  assert.equal(typeof sdk.scenario[name], "function", name);
}
assert.equal(typeof sdk.voice.OpenAIRealtimeAgentAdapter, "function");
assert.equal(typeof sdk.voice.ElevenLabsAgentAdapter, "function");
let ended = 0;
sdk.setupScenarioTracing({
  langwatch: "disabled",
  instrumentations: [],
  resourceDetectors: [],
  spanProcessors: [{
    onStart() {}, onEnd() { ended++; },
    async shutdown() {}, async forceFlush() {},
  }],
});
assert.ok(loaded(/[/\\]@opentelemetry[/\\]sdk-node[/\\]/).length > 0);
const { trace } = require("@opentelemetry/api");
const span = trace.getTracer("startup-regression").startSpan("ready");
assert.ok(span.isRecording(), "tracing is ready before setup returns");
span.end();
assert.equal(ended, 1, "the supplied processor receives the real span");
sdk.setupScenarioTracing();
trace.getTracer("startup-regression").startSpan("second").end();
assert.equal(ended, 2, "repeated setup does not register processors twice");
console.log("ready");
process.exit(0);
