// Summaries and measuring helpers, the twin of go/stats/stats.go.
import fs from "node:fs";
import v8 from "node:v8";

/** Nearest-rank quantile of sorted xs. */
export function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const i = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(i, sorted.length - 1))];
}

/** Median, nearest-rank p95, mean, min and max. */
export function summarize(xs) {
  if (xs.length === 0) return { n: 0, median: 0, p95: 0, mean: 0, min: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    median: quantile(s, 0.5),
    p95: quantile(s, 0.95),
    mean: sum / s.length,
    min: s[0],
    max: s[s.length - 1],
  };
}

/** Peak RSS of this process so far, in bytes (resourceUsage reports KB). */
export const maxRssBytes = () => process.resourceUsage().maxRSS * 1024;

export const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

export function writeJson(file, doc) {
  const text = JSON.stringify(doc, null, 2) + "\n";
  if (file) fs.writeFileSync(file, text);
  else process.stdout.write(text);
}

/** Parses --key=value and --flag arguments. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}

export function requireGc() {
  if (typeof globalThis.gc !== "function") {
    throw new Error("run node with --expose-gc");
  }
  return globalThis.gc;
}

/**
 * Measures the V8 heap bytes allocated while `body` runs, GCs included:
 * used heap at the end minus at the start, plus what every GC in between
 * reclaimed (v8.GCProfiler reports the used heap before and after each).
 * ArrayBuffer backing stores live outside the V8 heap and are not counted.
 * Also returns the number of GCs and their main-thread time.
 */
export async function measureHeapAllocation(body) {
  const gc = requireGc();
  gc();
  const profiler = new v8.GCProfiler();
  const ab0 = process.memoryUsage().arrayBuffers;
  const used0 = v8.getHeapStatistics().used_heap_size;
  profiler.start();
  await body();
  const used1 = v8.getHeapStatistics().used_heap_size;
  const data = profiler.stop();
  const ab1 = process.memoryUsage().arrayBuffers;
  let reclaimed = 0;
  let gcMicros = 0;
  const stats = data?.statistics ?? [];
  for (const s of stats) {
    reclaimed += (s.beforeGC?.heapStatistics?.usedHeapSize ?? 0) - (s.afterGC?.heapStatistics?.usedHeapSize ?? 0);
    gcMicros += s.cost ?? 0;
  }
  return {
    heapAllocatedBytes: used1 - used0 + reclaimed,
    arrayBufferDeltaBytes: ab1 - ab0,
    gcCount: stats.length,
    gcMs: gcMicros / 1000,
  };
}
