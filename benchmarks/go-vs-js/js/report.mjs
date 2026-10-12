// Turns the raw results of run.sh into results.md: one table per part,
// Go next to JS with the ratio.
//
//   node js/report.mjs --raw=results/raw --out=results.md [--git=REV] [--max-load=4]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, summarize } from "./lib/stats.mjs";

const args = parseArgs();
const raw = path.resolve(args.raw ?? "results/raw");
const out = path.resolve(args.out ?? "results.md");
const maxLoad = Number(args["max-load"] ?? 4);

const readJson = (name) => {
  const f = path.join(raw, name);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : undefined;
};
const readText = (name) => {
  const f = path.join(raw, name);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : "";
};

// ---- formatting --------------------------------------------------------

const num = (v, digits = 2) =>
  v == null || Number.isNaN(v) ? "n/a" : Number(v).toLocaleString("en-US", { maximumFractionDigits: digits });
const ms = (v) => (v == null ? "n/a" : `${num(v, v < 10 ? 3 : 1)} ms`);
const ns = (v) => {
  if (v == null) return "n/a";
  if (v >= 1e6) return `${num(v / 1e6, 2)} ms`;
  if (v >= 1e3) return `${num(v / 1e3, 2)} µs`;
  return `${num(v, 1)} ns`;
};
const bytes = (v) => {
  if (v == null || Number.isNaN(v)) return "n/a";
  const a = Math.abs(v);
  if (a >= 1 << 20) return `${num(v / (1 << 20), 2)} MiB`;
  if (a >= 1 << 10) return `${num(v / (1 << 10), 1)} KiB`;
  return `${num(v, 0)} B`;
};
/** How many times larger b is than a (JS ÷ Go for costs). */
const ratio = (a, b) => (a == null || b == null || a === 0 ? "n/a" : `${num(b / a, 2)}×`);

const table = (head, rows) =>
  [`| ${head.join(" | ")} |`, `|${head.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

// ---- go test -bench output --------------------------------------------

/** Median ns/op, B/op and allocs/op per benchmark name, over -count runs. */
function parseGoBench(text) {
  const acc = {};
  for (const line of text.split("\n")) {
    const m = /^(Benchmark\S+?)(?:-\d+)?\s+\d+\s+([\d.]+) ns\/op(.*)$/.exec(line.trim());
    if (!m) continue;
    const e = (acc[m[1]] ??= { ns: [], b: [], allocs: [] });
    e.ns.push(Number(m[2]));
    const b = /([\d.]+) B\/op/.exec(m[3]);
    const a = /([\d.]+) allocs\/op/.exec(m[3]);
    if (b) e.b.push(Number(b[1]));
    if (a) e.allocs.push(Number(a[1]));
  }
  const res = {};
  for (const [k, e] of Object.entries(acc)) {
    res[k] = { ns: summarize(e.ns).median, b: summarize(e.b).median, allocs: summarize(e.allocs).median, n: e.ns.length };
  }
  return res;
}

const goMicro = parseGoBench(readText("go-micro.txt") + "\n" + readText("go-digest.txt") + "\n" + readText("go-voice.txt"));
const jsMicro = { ...(readJson("js-micro.json")?.results ?? {}), ...(readJson("js-voice.json")?.results ?? {}) };

// ---- document ------------------------------------------------------------

const md = [];
const loadStart = readText("uptime-start.txt");
const loadEnd = readText("uptime-end.txt");
const load1 = (s) => Number((/load averages?:\s*([\d.]+)/.exec(s) ?? [])[1]);
const goTiming = readJson("go-timing.json");

md.push("# Go vs JS SDK benchmark results", "");
md.push(`Generated ${new Date().toISOString()} by benchmarks/go-vs-js/run.sh. Method and caveats: README.md.`, "");
md.push(
  table(
    ["Environment", ""],
    [
      ["Machine", `${os.type()} ${os.release()} ${os.arch()}, ${os.cpus().length} × ${os.cpus()[0]?.model ?? "?"}, ${bytes(os.totalmem())} RAM`],
      ["Go", `${goTiming?.go_version ?? "?"} (GOMAXPROCS ${goTiming?.gomaxprocs ?? "?"})`],
      ["Node", process.version],
      ["Commit", args.git ?? "?"],
      ["Settings", `\`${readText("run-config.txt")}\``],
      ["Load at start", `\`${loadStart}\``],
      ["Load at end", `\`${loadEnd}\``],
    ]
  ),
  ""
);
if (/QUICK=1/.test(readText("run-config.txt"))) {
  md.push("> **QUICK=1 smoke run: counts are tiny, do not read anything into these numbers.**", "");
}
for (const [when, s] of [["start", loadStart], ["end", loadEnd]]) {
  if (load1(s) > maxLoad) {
    md.push(`> **WARNING: the 1-minute load average at the ${when} was ${load1(s)}, above ${maxLoad}. These numbers are not trustworthy.**`, "");
  }
}
md.push("Ratios are JS ÷ Go: above 1× means JS takes longer or uses more; for throughput, Go ÷ JS.", "");

// 1. Cold start
const cold = readJson("coldstart.json");
md.push("## 1. Cold start", "");
if (cold) {
  md.push(
    `Whole process, ${cold.reps} interleaved repetitions: start, set up tracing, run the trivial scenario (scripted user message, fixed agent answer, succeed), exit.`,
    ""
  );
  const g = cold.go;
  const rows = [
    ["Go binary", g],
    ["JS ESM (dist/index.mjs)", cold.js_esm],
    ["JS CJS (dist/index.js)", cold.js_cjs],
  ].map(([name, d]) => [
    name,
    ms(d.wall_ms.median),
    ms(d.wall_ms.p95),
    ratio(g.wall_ms.median, d.wall_ms.median),
    bytes(d.maxrss_bytes.median),
    ratio(g.maxrss_bytes.median, d.maxrss_bytes.median),
  ]);
  md.push(table(["", "wall median", "wall p95", "÷ Go", "peak RSS median", "÷ Go"], rows), "");
} else md.push("_not run_", "");

// 2. Full scenario
md.push("## 2. Full scenario (10 turns, user simulator + agent + judge)", "");
const t = { go: goTiming, aisdk: readJson("js-aisdk-timing.json"), direct: readJson("js-direct-timing.json") };
const a = { go: readJson("go-alloc.json"), aisdk: readJson("js-aisdk-alloc.json"), direct: readJson("js-direct-alloc.json") };
if (t.go || t.aisdk || t.direct) {
  const row = (label, get, fmt) => {
    const g = get("go");
    const x = get("aisdk");
    const y = get("direct");
    return [label, fmt(g), fmt(x), ratio(g, x), fmt(y), ratio(g, y)];
  };
  const tv = (k, f) => (s) => (t[s] ? f(t[s][k]) : undefined);
  const av = (k) => (s) => a[s]?.[k];
  md.push(
    table(
      ["per run", "Go", "JS (AI SDK)", "÷ Go", "JS (invokeLLM)", "÷ Go"],
      [
        row("time, median", tv("run_ms", (v) => v?.median), ms),
        row("time, p95", tv("run_ms", (v) => v?.p95), ms),
        row("time, mean", tv("run_ms", (v) => v?.mean), ms),
        row("heap allocated", (s) => (s === "go" ? a.go?.alloc_bytes_per_run : a[s]?.heap_alloc_bytes_per_run), bytes),
        ["allocations (count)", num(a.go?.allocs_per_run, 0), "n/a", "", "n/a", ""],
        row("retained after GC", av("retained_bytes_per_run"), bytes),
        row("garbage collections", av("gc_count_per_run"), (v) => num(v, 2)),
        row("GC time (Go: STW pauses; JS: main thread)", (s) => (s === "go" ? a.go?.gc_pause_ms_per_run : a[s]?.gc_ms_per_run), ms),
        row("events posted", tv("events_per_run", (v) => v), (v) => num(v, 1)),
        row("event bytes posted", tv("event_bytes_per_run", (v) => v), bytes),
        row("messages", tv("messages_per_run", (v) => v), (v) => num(v, 0)),
        row("spans exported", tv("spans_per_run", (v) => v), (v) => num(v, 1)),
        row("AI SDK warnings dropped, not printed", tv("dropped_ai_sdk_warnings_per_run", (v) => v), (v) => num(v, 1)),
      ]
    ),
    ""
  );
  md.push(
    "Events, messages and spans are a parity check: messages and events must match. Spans differ by design: both SDKs export the run, turn and agent call spans (41); Go adds one chat span per user simulator and judge model call (20), the AI SDK two (40), and the invokeLLM column none. Event bytes differ a little in the AI SDK column because the AI SDK returns the agent's answer as a list of text parts rather than a string (see README.md).",
    ""
  );
} else md.push("_not run_", "");

// Throughput
const levels = (args.par ?? "1,8,32").split(/[ ,]+/).filter(Boolean).map(Number);
const par = (name, n) => readJson(`${name}-parallel-${n}.json`);
if (levels.some((n) => par("go", n))) {
  md.push("### Throughput with N parallel scenarios", "");
  md.push("Go runs N goroutines on all cores (and, for a like-for-like single-thread view, with GOMAXPROCS=1); JS runs N concurrent promises on its one event loop thread.", "");
  const rows = levels.map((n) => {
    const g = par("go", n)?.runs_per_sec;
    const g1 = par("go-p1", n)?.runs_per_sec;
    const x = par("js-aisdk", n)?.runs_per_sec;
    const y = par("js-direct", n)?.runs_per_sec;
    const r = (go, js) => (go == null || js == null || js === 0 ? "n/a" : `${num(go / js, 2)}×`);
    return [String(n), num(g, 1), num(g1, 1), num(x, 1), num(y, 1), r(g, x), r(g1, x), r(g1, y)];
  });
  md.push(
    table(
      ["N", "Go runs/s", "Go 1 core runs/s", "JS (AI SDK) runs/s", "JS (invokeLLM) runs/s", "Go ÷ JS (AI SDK)", "Go 1 core ÷ JS (AI SDK)", "Go 1 core ÷ JS (invokeLLM)"],
      rows
    ),
    ""
  );
  const rss = levels.map((n) => [
    String(n),
    bytes(par("go", n)?.maxrss_bytes),
    bytes(par("go-p1", n)?.maxrss_bytes),
    bytes(par("js-aisdk", n)?.maxrss_bytes),
    bytes(par("js-direct", n)?.maxrss_bytes),
  ]);
  md.push(table(["N", "Go peak RSS", "Go 1 core peak RSS", "JS (AI SDK) peak RSS", "JS (invokeLLM) peak RSS"], rss), "");
}

// 3 and 4. Micro and voice
const microRows = [
  ["Judge span digest, 50 spans", "BenchmarkDigestFormat50", "digest.format50", "both build the full digest from scratch"],
  ["Judge span digest, 50 spans, as the judge runs it", "BenchmarkCachedDigestFormat50", "digest.format50", "Go judge reuses each span's compiled digest; JS has no cache"],
  ["Structure-only digest, 50 spans", "BenchmarkDigestStructureOnly50", "digest.structure50", ""],
  ["AG-UI conversion, 20 messages", "BenchmarkGoVsJSAGUIConvert20", "agui.convert20", "Go writes JSON rows; JS builds objects"],
  ["MESSAGE_SNAPSHOT body, 20 messages, from scratch", "BenchmarkGoVsJSSnapshotFromScratch20", "event.snapshot20", "convert + envelope + JSON on both"],
  ["MESSAGE_SNAPSHOT body, 20 messages, as the SDK runs it", "BenchmarkGoVsJSSnapshotCached20", "event.snapshot20", "Go caches each message's JSON per run; JS redoes it per event"],
];
const voiceRows = [
  ["µ-law encode, 20 ms at 8 kHz", "BenchmarkVoiceMulawEncodeFrame", "voice.mulaw.encode.frame"],
  ["µ-law decode, 20 ms at 8 kHz", "BenchmarkVoiceMulawDecodeFrame", "voice.mulaw.decode.frame"],
  ["Resample 24 kHz → 8 kHz, 20 ms", "BenchmarkVoiceResample24kTo8kFrame", "voice.resample.24to8.frame"],
  ["Resample 8 kHz → 24 kHz, 20 ms", "BenchmarkVoiceResample8kTo24kFrame", "voice.resample.8to24.frame"],
  ["PCM16 24 kHz → µ-law 8 kHz (Twilio out), 20 ms", "BenchmarkVoiceTelephonyOutFrame", "voice.telephony.out.frame"],
  ["µ-law 8 kHz → PCM16 24 kHz (Twilio in), 20 ms", "BenchmarkVoiceTelephonyInFrame", "voice.telephony.in.frame"],
  ["Effect chain (noise, phone, packet loss), 20 ms", "BenchmarkVoiceEffectChainFrame", "voice.effects.chain.frame"],
  ["Effect chain (noise, phone, packet loss), 1 s", "BenchmarkVoiceEffectChain1s", "voice.effects.chain.1s"],
];
const microTable = (rows) =>
  table(
    ["", "Go time/op", "Go B/op", "Go allocs/op", "JS time/op", "JS heap B/op", "time ÷ Go", "note"],
    rows.map(([label, goName, jsKey, note = ""]) => {
      const g = goMicro[goName];
      const j = jsMicro[jsKey];
      return [label, ns(g?.ns), bytes(g?.b), num(g?.allocs, 0), ns(j?.ns_per_op?.median), bytes(j?.heap_bytes_per_op), ratio(g?.ns, j?.ns_per_op?.median), note];
    })
  );
// run.sh exports the -count and -benchtime it gave go test.
const benchCount = Number(process.env.BENCH_COUNT ?? 5);
const benchBatchMs = Number(process.env.BENCH_BATCH_MS ?? 1000);
const batchText = benchBatchMs >= 1000 ? `${num(benchBatchMs / 1000, 2)} s` : `${num(benchBatchMs, 0)} ms`;
md.push(
  "## 3. Micro benchmarks",
  "",
  `Median of ${benchCount} runs of about ${batchText} each on both sides.`,
  "",
  microTable(microRows),
  ""
);
md.push(
  "## 4. Voice audio paths",
  "",
  "Go appends into a reused buffer (its adapters' hot path); JS allocates a new Uint8Array per call, whose bytes live outside the V8 heap and so are not in \"JS heap B/op\".",
  "",
  microTable(voiceRows),
  ""
);

fs.writeFileSync(out, md.join("\n"));
console.log(`wrote ${out}`);
