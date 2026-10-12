// Micro benchmarks of the JS SDK, with the inputs of the Go benchmarks they
// are compared with (see README.md, "What the micro benchmarks compare"):
//
//   digest.format50      JudgeSpanDigestFormatter.format, 50 spans (dist)
//   digest.structure50   JudgeSpanDigestFormatter.formatStructureOnly (dist)
//   agui.convert20       convertModelMessagesToAguiMessages, 20 messages
//   event.snapshot20     one MESSAGE_SNAPSHOT body: convert the 20 messages,
//                        EventReporter's processEventForApi, JSON.stringify
//
// Run with node --expose-gc, after js/build-internals.mjs.
import { importInternals, importSdk } from "./lib/paths.mjs";
import { bench, benchChecksum } from "./lib/bench.mjs";
import { parseArgs, writeJson } from "./lib/stats.mjs";

process.env.SCENARIO_DISABLE_SIMULATION_REPORT_INFO ??= "1";
process.env.LOG_LEVEL ??= "error";

const args = parseArgs();
const sdk = await importSdk();
const internals = await importInternals();

/**
 * The 50 spans of go/internal/spandigest/bench_test.go benchSpans(50): a
 * tree (span i's parent is (i-1)/3), JSON input and output attributes, an
 * error every tenth span. Ids, times and attributes are the same.
 */
function benchSpans(n) {
  const hex16 = (v) => v.toString(16).padStart(16, "0");
  const traceId = "01" + "0".repeat(30);
  const input = `{"type":"chat_messages","value":[{"role":"user","content":"${"hello world ".repeat(20)}"}]}`;
  const output = `{"type":"text","value":"${"answer ".repeat(30)}"}`;
  const spans = [];
  for (let i = 0; i < n; i++) {
    const spanId = hex16((i + 1) & 0xffff);
    const parentSpanId = i > 0 ? hex16((((i - 1) / 3) | 0) + 1) : undefined;
    spans.push({
      name: `span-${i}`,
      kind: 0,
      spanContext: () => ({ traceId, spanId, traceFlags: 1 }),
      parentSpanContext: parentSpanId ? { traceId, spanId: parentSpanId, traceFlags: 1 } : undefined,
      startTime: [1700000000, i * 1_000_000],
      endTime: [1700000000, (i + 5) * 1_000_000],
      duration: [0, 5_000_000],
      attributes: {
        "langwatch.span.type": "llm",
        "gen_ai.request.model": "gpt-4o-mini",
        "langwatch.input": input,
        "langwatch.output": output,
        "gen_ai.usage.input_tokens": 120,
      },
      // OpenTelemetry JS: 2 is ERROR (Go's codes.Error is 1).
      status: i % 10 === 9 ? { code: 2, message: "boom" } : { code: 0 },
      events: [],
      links: [],
      ended: true,
      resource: { attributes: {} },
      instrumentationScope: { name: "bench" },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    });
  }
  return spans;
}

/** The 20 messages of inpkg/zz_govsjs_bench_test.go govsjsMessages. */
function benchMessages() {
  const out = [];
  for (let i = 0; i < 20; i++) {
    const id = `msg_${String(i).padStart(2, "0")}`;
    out.push(
      i % 2 === 0
        ? { id, role: "user", content: `user message number ${i} with some text` }
        : { id, role: "assistant", content: `assistant reply number ${i} with some longer text in it` }
    );
  }
  return out;
}

const formatter = new sdk.JudgeSpanDigestFormatter();
const spans = benchSpans(50);
const messages = benchMessages();
const reporter = new internals.EventReporter({ endpoint: "http://127.0.0.1:9", apiKey: undefined });
const convert = internals.convertModelMessagesToAguiMessages;

const snapshot = () => {
  const event = {
    type: "MESSAGE_SNAPSHOT",
    timestamp: 1700000000000,
    batchRunId: "b",
    scenarioId: "i",
    scenarioRunId: "r",
    scenarioSetId: "s",
    messages: convert(messages),
  };
  // processEventForApi is TypeScript-private; it is what postEvent runs
  // before JSON.stringify.
  return JSON.stringify(reporter.processEventForApi(event));
};

const cases = {
  "digest.format50": () => formatter.format(spans),
  "digest.structure50": () => formatter.formatStructureOnly(spans),
  "agui.convert20": () => convert(messages),
  "event.snapshot20": snapshot,
};

const results = {};
for (const [name, fn] of Object.entries(cases)) {
  results[name] = await bench(fn);
}
writeJson(args.out, { sdk: "js", node_version: process.version, results, checksum: benchChecksum() });
