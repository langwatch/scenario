// Full 10-turn scenario with the JS SDK, the twin of go/cmd/scenario:
//
//   --phase=timing    per-run wall time over many sequential runs
//   --phase=alloc     V8 heap bytes allocated per run (GCProfiler), retained
//                     heap after gc(), GC count and time
//   --phase=parallel  throughput of --par concurrent runs (promises)
//   --mode=aisdk      fake LanguageModelV3 through the AI SDK (default)
//   --mode=direct     invokeLLM replaced, no AI SDK (see lib/fake-model.mjs)
//
// Run with node --expose-gc. Every phase starts the in-process event sink
// and points the run at it, and writes one JSON document to --out.
import { runFull, setup } from "./lib/setup.mjs";
import { startSink } from "./lib/sink.mjs";
import {
  maxRssBytes,
  measureHeapAllocation,
  nowMs,
  parseArgs,
  requireGc,
  summarize,
  writeJson,
} from "./lib/stats.mjs";

const args = parseArgs();
const phase = args.phase ?? "timing";
const mode = args.mode ?? "aisdk";
const warmup = Number(args.warmup ?? 30);
const runs = Number(args.runs ?? 200);
const par = Number(args.par ?? 8);
const total = Number(args.total ?? 256);
if (!["aisdk", "direct"].includes(mode)) throw new Error(`unknown mode ${mode}`);

const env = await setup({ needAi: mode === "aisdk" });
const sink = await startSink();

async function once() {
  const n = await runFull(env, mode, sink.url);
  return n;
}

for (let i = 0; i < warmup; i++) {
  await once();
  env.exporter.reset();
}

const doc = { sdk: "js", mode, phase, node_version: process.version, warmup };

if (phase === "timing") {
  const durations = [];
  const c0 = sink.counts();
  let spans = 0;
  let messages = 0;
  for (let i = 0; i < runs; i++) {
    const start = nowMs();
    messages = await once();
    durations.push(nowMs() - start);
    spans += env.exporter.getFinishedSpans().length;
    env.exporter.reset();
  }
  const c1 = sink.counts();
  doc.run_ms = summarize(durations);
  doc.messages_per_run = messages;
  doc.events_per_run = (c1.events - c0.events) / runs;
  doc.event_bytes_per_run = (c1.bytes - c0.bytes) / runs;
  doc.spans_per_run = spans / runs;
} else if (phase === "alloc") {
  const gc = requireGc();
  const m = await measureHeapAllocation(async () => {
    for (let i = 0; i < runs; i++) {
      await once();
      env.exporter.reset();
    }
  });
  doc.heap_alloc_bytes_per_run = m.heapAllocatedBytes / runs;
  doc.gc_count_per_run = m.gcCount / runs;
  doc.gc_ms_per_run = m.gcMs / runs;

  // Retained heap: what stays reachable after runs, per run (0 when
  // nothing leaks). Compared with the Go HeapAlloc after runtime.GC().
  gc();
  const before = process.memoryUsage();
  for (let i = 0; i < runs; i++) {
    await once();
    env.exporter.reset();
  }
  gc();
  const after = process.memoryUsage();
  doc.heap_used_after_gc = after.heapUsed;
  doc.retained_bytes_per_run = (after.heapUsed - before.heapUsed) / runs;
  doc.retained_array_buffer_bytes_per_run = (after.arrayBuffers - before.arrayBuffers) / runs;
} else if (phase === "parallel") {
  let next = 0;
  const start = nowMs();
  const worker = async () => {
    while (next++ < total) {
      await once();
      env.exporter.reset();
    }
  };
  await Promise.all(Array.from({ length: par }, worker));
  const wall = nowMs() - start;
  doc.par = par;
  doc.total_runs = total;
  doc.wall_ms = wall;
  doc.runs_per_sec = total / (wall / 1000);
} else {
  throw new Error(`unknown phase ${phase}`);
}

doc.maxrss_bytes = maxRssBytes();
writeJson(args.out, doc);
await sink.close();
process.exit(0);
