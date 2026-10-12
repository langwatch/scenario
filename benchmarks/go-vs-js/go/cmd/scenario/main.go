// Command scenario measures the full 10-turn scenario with the Go SDK:
//
//	-phase timing    per-run wall time over many sequential runs
//	-phase alloc     testing.Benchmark allocations per run, and retained heap
//	-phase parallel  throughput of -par concurrent runs (goroutines)
//
// Every phase starts the in-process event sink and points the run at it, and
// writes one JSON document to -out. The JS twin is js/scenario.mjs.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/langwatch/scenario/benchmarks/go-vs-js/fake"
	"github.com/langwatch/scenario/benchmarks/go-vs-js/stats"
)

func main() {
	testing.Init()
	phase := flag.String("phase", "timing", "timing, alloc or parallel")
	warmup := flag.Int("warmup", 30, "runs before measuring")
	runs := flag.Int("runs", 200, "measured runs (timing, alloc)")
	par := flag.Int("par", 8, "concurrent runs (parallel)")
	total := flag.Int("total", 256, "runs in total across workers (parallel)")
	out := flag.String("out", "", "JSON output file (stdout when empty)")
	flag.Parse()

	if err := fake.Setup(); err != nil {
		fail("setup", err)
	}
	sink, err := fake.StartSink()
	if err != nil {
		fail("sink", err)
	}
	defer sink.Close()

	ctx := context.Background()
	for range *warmup {
		if _, err := fake.RunFull(ctx, sink.URL); err != nil {
			fail("warmup", err)
		}
		fake.Exporter.Reset()
	}

	doc := map[string]any{
		"sdk":        "go",
		"phase":      *phase,
		"go_version": runtime.Version(),
		"gomaxprocs": runtime.GOMAXPROCS(0),
		"warmup":     *warmup,
	}
	switch *phase {
	case "timing":
		timing(ctx, sink, *runs, doc)
	case "alloc":
		alloc(ctx, sink, *runs, doc)
	case "parallel":
		parallel(ctx, sink, *par, *total, doc)
	default:
		fail("phase", fmt.Errorf("unknown phase %q", *phase))
	}
	doc["maxrss_bytes"] = stats.MaxRSSBytes()
	if err := stats.WriteJSON(*out, doc); err != nil {
		fail("write", err)
	}
}

func timing(ctx context.Context, sink *fake.Sink, runs int, doc map[string]any) {
	durations := make([]float64, 0, runs)
	ev0, by0 := sink.Counts()
	spans, messages := 0, 0
	for range runs {
		start := time.Now()
		n, err := fake.RunFull(ctx, sink.URL)
		durations = append(durations, float64(time.Since(start).Nanoseconds())/1e6)
		if err != nil {
			fail("run", err)
		}
		messages = n
		spans += len(fake.Exporter.GetSpans())
		fake.Exporter.Reset()
	}
	ev1, by1 := sink.Counts()
	doc["run_ms"] = stats.Summarize(durations)
	doc["messages_per_run"] = messages
	doc["events_per_run"] = float64(ev1-ev0) / float64(runs)
	doc["event_bytes_per_run"] = float64(by1-by0) / float64(runs)
	doc["spans_per_run"] = float64(spans) / float64(runs)
}

func alloc(ctx context.Context, sink *fake.Sink, runs int, doc map[string]any) {
	if err := flag.Set("test.benchtime", fmt.Sprintf("%dx", runs)); err != nil {
		fail("benchtime", err)
	}
	var runErr error
	res := testing.Benchmark(func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			if _, err := fake.RunFull(ctx, sink.URL); err != nil {
				runErr = err
				b.FailNow()
			}
			fake.Exporter.Reset()
		}
	})
	if runErr != nil {
		fail("run", runErr)
	}
	doc["bench_n"] = res.N
	doc["ns_per_run"] = res.NsPerOp()
	doc["allocs_per_run"] = res.AllocsPerOp()
	doc["alloc_bytes_per_run"] = res.AllocedBytesPerOp()

	// Retained heap: what stays reachable after runs, per run (0 when
	// nothing leaks). Compared with the JS heapUsed after gc().
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	for range runs {
		if _, err := fake.RunFull(ctx, sink.URL); err != nil {
			fail("run", err)
		}
		fake.Exporter.Reset()
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	doc["heap_live_bytes_after_gc"] = after.HeapAlloc
	doc["retained_bytes_per_run"] = (float64(after.HeapAlloc) - float64(before.HeapAlloc)) / float64(runs)
	doc["gc_count_per_run"] = float64(after.NumGC-before.NumGC) / float64(runs)
	// Stop-the-world pauses only; Go's concurrent marking runs beside the
	// program and is not in here (nor is V8's concurrent marking on the JS
	// side, whose GCProfiler cost is the main-thread time).
	doc["gc_pause_ms_per_run"] = float64(after.PauseTotalNs-before.PauseTotalNs) / 1e6 / float64(runs)
}

func parallel(ctx context.Context, sink *fake.Sink, par, total int, doc map[string]any) {
	var next atomic.Int64
	var firstErr error
	var errOnce sync.Once
	var wg sync.WaitGroup
	start := time.Now()
	for range par {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for next.Add(1) <= int64(total) {
				if _, err := fake.RunFull(ctx, sink.URL); err != nil {
					errOnce.Do(func() { firstErr = err })
					return
				}
				fake.Exporter.Reset()
			}
		}()
	}
	wg.Wait()
	wall := time.Since(start)
	if firstErr != nil {
		fail("run", firstErr)
	}
	doc["par"] = par
	doc["total_runs"] = total
	doc["wall_ms"] = float64(wall.Nanoseconds()) / 1e6
	doc["runs_per_sec"] = float64(total) / wall.Seconds()
}

func fail(what string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", what, err)
	os.Exit(1)
}
