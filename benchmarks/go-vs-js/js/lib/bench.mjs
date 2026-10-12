// A small benchmark loop for synchronous functions, shaped like
// `go test -bench -count N -benchtime T`: warm up (so the JIT has optimized
// the function), then N batches of about T each, ns/op per batch, median
// reported. Each result is folded into a checksum so the JIT cannot drop
// the call.
import { measureHeapAllocation, nowMs, summarize } from "./stats.mjs";

let checksum = 0;

function consume(v) {
  if (typeof v === "string" || v instanceof Uint8Array || Array.isArray(v)) checksum += v.length;
  else if (v != null) checksum += 1;
}

/** The checksum, printed by the callers so it is observable. */
export const benchChecksum = () => checksum;

export async function bench(fn, opts = {}) {
  const batches = opts.batches ?? Number(process.env.BENCH_COUNT ?? 5);
  const batchMs = opts.batchMs ?? Number(process.env.BENCH_BATCH_MS ?? 1000);
  const warmupMs = opts.warmupMs ?? Math.max(200, batchMs / 2);

  let it = 0;
  const w0 = nowMs();
  while (nowMs() - w0 < warmupMs) {
    consume(fn());
    it++;
  }
  const perOpMs = (nowMs() - w0) / it;
  const n = Math.max(1, Math.round(batchMs / perOpMs));

  const ns = [];
  for (let b = 0; b < batches; b++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) consume(fn());
    ns.push(Number(process.hrtime.bigint() - t0) / n);
  }

  // Heap bytes per call, over a fixed number of calls (GCs accounted for).
  const allocN = Math.max(100, Math.min(n, 20_000));
  const alloc = await measureHeapAllocation(async () => {
    for (let i = 0; i < allocN; i++) consume(fn());
  });

  return {
    iterations_per_batch: n,
    ns_per_op: summarize(ns),
    heap_bytes_per_op: alloc.heapAllocatedBytes / allocN,
  };
}
