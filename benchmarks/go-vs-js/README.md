# Go vs JS SDK benchmark

A harness that compares the Go SDK (`go/`) and the JS SDK (`javascript/`) on
the same machine, against the same deterministic fake model, without network.
One command builds what it needs, runs every part and writes `results.md`:

```sh
benchmarks/go-vs-js/run.sh          # full run, about 20-30 minutes
QUICK=1 benchmarks/go-vs-js/run.sh  # smoke run with tiny counts, to check the setup
```

Run it on a quiet machine. `run.sh` reads the 1-minute load average with
`uptime` and refuses to start above 4 (`MAX_LOAD`); `FORCE=1` runs anyway,
and `results.md` then carries a warning. The load average at the start and
at the end is recorded in `results.md`.

Requirements: Go 1.25+, Node 20+ (`v8.GCProfiler` is needed for the JS heap
numbers), and pnpm when `javascript/node_modules` is missing or to rebuild
`javascript/dist` (set `SKIP_JS_BUILD=1` to use the existing build). The JS
code here has no `package.json` and installs nothing: it imports the built
package from `javascript/dist` and resolves its dependencies (`ai`,
`@opentelemetry/sdk-trace-base`, `tsup`) from `javascript/node_modules`.

Other settings, all environment variables: `ONLY` (any of `coldstart
scenario parallel micro voice`), `REPS`, `WARMUP`, `RUNS`, `ALLOC_RUNS`,
`PAR_LEVELS` (default `1 8 32`), `PAR_TOTAL`, `BENCH_COUNT`, `BENCHTIME`,
`SCENARIO_JS_DIR` (another checkout of the JS package).

## What is measured

| Part | Go | JS |
|---|---|---|
| 1. Cold start: whole process, time and peak RSS, median and p95 of 40 interleaved repetitions | the `go/cmd/coldstart` binary | `node js/coldstart.mjs` (ESM, `dist/index.mjs`) and `node js/coldstart.cjs` (CJS, `dist/index.js`) |
| 2. Full scenario: time per run (median, p95, mean of 200 runs after 30 warm-up runs), heap allocated, retained heap, garbage collections | `go/cmd/scenario -phase timing\|alloc` (`testing.Benchmark` for allocations and bytes) | `node --expose-gc js/scenario.mjs --phase=timing\|alloc` (`v8.GCProfiler`, `process.memoryUsage`, `gc()`) |
| 2. Throughput with N parallel scenarios | N goroutines, all cores, and again with `GOMAXPROCS=1` | N concurrent promises |
| 3. Micro: judge span digest, AG-UI conversion, event encoding | `go test -bench` (see below) | `js/micro.mjs` |
| 4. Voice audio paths per 20 ms frame | `go/voicebench` | `js/voice.mjs` |

The cold start scenario is the smallest real run: set up tracing, one
scripted user message, one fixed agent answer, `succeed()`. The driver
(`js/coldstart-driver.mjs`) times each process from the outside with
`spawnSync`, so runtime start, module loading and the first run are inside
the time; each process reports its own peak RSS. No events are posted in the
cold start (no LangWatch key), on either side.

## The full scenario, and why both SDKs do the same work

Ten turns with the user simulator, the agent under test and the judge, all
backed by one scripted model (`go/fake/script.go` and
`js/lib/fake-model.mjs`, word for word the same). The model only looks at
which tools a request offers and whether the last message is a tool result:

| Request | Answer |
|---|---|
| offers `finish_test` (judge, verdict on the last turn) | calls `finish_test`, criterion `agent_responds` passed |
| offers `continue_test` (judge, decision on each turn before the last) | calls `continue_test` |
| offers `get_order_status` (agent under test) | calls it with `{"order_id":"42"}`; once the last message is its result, answers with fixed text |
| no tools (user simulator) | fixed user text |

So each turn is one user simulator call, two agent model calls with one tool
run in between, and one judge call: 40 messages and 40 model calls per run.
Tool call ids restart at `call_1` each run on both sides.

Both sides also share:

- **Tracing on, exported in memory.** Go: `SetupScenarioTracing` with an
  `InMemoryExporter` behind a simple (synchronous) span processor and
  `DisableLangWatchExporter`. JS: `setupScenarioTracing({ langwatch:
  "disabled", traceExporter: new InMemorySpanExporter(), instrumentations:
  [] })`, which puts the exporter behind a `SimpleSpanProcessor`. The judge
  reads spans through each SDK's own span collector. The exporter is emptied
  after each run.
- **Event reporting to a local sink.** Each program starts an HTTP server in
  its own process (`go/fake/sink.go`, `js/lib/sink.mjs`) that reads the body,
  counts it and answers 200 `{}`, and passes it to the run as the LangWatch
  endpoint with a dummy key. `LANGWATCH_*` variables are unset.
- **Same environment**: `SCENARIO_BROWSER=never`, `SCENARIO_HEADLESS=1`,
  `SCENARIO_DISABLE_SIMULATION_REPORT_INFO=1`, `LOG_LEVEL=error`.
- **A parity check in `results.md`**: messages, events and event bytes
  posted, and spans exported per run, side by side. Messages and events
  should match; if they do not, the two SDKs are not doing the same work and
  the timing rows should not be compared.

### How the JS side fakes the model

The JS tests in `javascript/src` fake the model in two ways, and the
benchmark runs both:

- **`aisdk` (main JS column).** A `LanguageModelV3` object
  (`specificationVersion: "v3"`, `doGenerate`), the same shape as the stubs
  in `javascript/src/voice/__tests__/factories.test.ts` and as
  `MockLanguageModelV3` from `ai/test`. Every call of the user simulator and
  the judge goes through the AI SDK's `generateText` with the telemetry the
  SDK switches on, as with a real provider; the agent under test uses
  `generateText` with one tool and `stopWhen: stepCountIs(2)`.
  `MockLanguageModelV3` itself is not used: it keeps every call in
  `doGenerateCalls`, which grows for the whole benchmark, and `ai/test` cannot
  be loaded from the built package without an install.
- **`direct` (second JS column).** What the agent unit tests do (for
  example `agents/judge/__tests__/judge-two-phase.unit.test.ts`): the
  agent's `invokeLLM` property is replaced by a function that returns the
  canned result, so the AI SDK is skipped. This is the closest match to the
  Go side, where the `scenario.LLM` interface has nothing under it.

## What the micro benchmarks compare

Go inputs come from the benchmark files named below; the JS inputs are built
to be identical (same span ids, times and attributes; same message ids and
texts).

| Row | Go | JS | Notes |
|---|---|---|---|
| Judge span digest, 50 spans | `spandigest.Format` (`go/internal/spandigest`, `BenchmarkDigestFormat50`, spans from `benchSpans(50)`) | `new JudgeSpanDigestFormatter().format(spans)` (dist) | Same work: the full digest from scratch. |
| ... as the judge runs it | `Cache.Format` (`BenchmarkCachedDigestFormat50`) | same `format` call | The Go judge reuses each span's compiled digest across turns; the JS judge rebuilds it on every call. |
| Structure-only digest | `spandigest.FormatStructureOnly` | `formatStructureOnly` (dist) | |
| AG-UI conversion, 20 messages | `aguiRows` per message (unexported; `inpkg/zz_govsjs_bench_test.go`) | `convertModelMessagesToAguiMessages` (`src/utils`, not in dist) | Go writes each message's JSON row; JS builds objects (no JSON yet). |
| MESSAGE_SNAPSHOT body, from scratch | `aguiRows` for the 20 messages, then `eventBase.snapshotPayload` | the conversion, then `EventReporter.processEventForApi`, then `JSON.stringify`, as `ScenarioExecution` and `postEvent` do | Same work on both sides. |
| ... as the SDK runs it | `snapshotPayload` over the run's cached rows (`ExecutionState.aguiRowsJSON`) | same as above | Go encodes each message once per run; JS converts and encodes the whole conversation for every snapshot event. |

The Go functions in the last three rows are unexported, so `run.sh` copies
`inpkg/zz_govsjs_bench_test.go` into `go/`, builds the test binary and
deletes the copy at once (also on exit). The JS functions that `dist` does
not export (the AG-UI converter, `EventReporter`, the Twilio codecs) are
bundled from `javascript/src` into `js/.build/internals.mjs` by
`js/build-internals.mjs`, with the package's own `tsup` (esbuild, target
node20, all imports bundled in).

## Voice audio paths

All on a 20 ms frame of a 440 Hz tone (amplitude 12000), plus the effect
chain on 1 s.

| Row | Go (`go/voice/audio`, `go/voice/effects`) | JS |
|---|---|---|
| µ-law encode, 8 kHz | `AppendMulaw` | `pcm16ToMulaw` |
| µ-law decode, 8 kHz | `AppendMulawDecoded` | `mulawToPcm16` |
| Resample 24 kHz to 8 kHz, and 8 kHz to 24 kHz | `AppendResampled` | `resamplePcm16` |
| Twilio outbound: PCM16 24 kHz to µ-law 8 kHz | `AppendMulaw8k` (resample and encode in one pass) | `pcm16At24kToMulaw8k` (two passes) |
| Twilio inbound: µ-law 8 kHz to PCM16 24 kHz | `AppendPCM24kFromMulaw8k` | `mulaw8kToPcm16At24k` |
| Effect chain | `Chain(BackgroundNoise(Cafe, 0.3), PhoneQuality(), PacketLoss(0.05, 20))` | `backgroundNoise("cafe", 0.3)`, `phoneQuality()`, `packetLoss(0.05, 20)` from `voice.effects` (dist), applied in order |

The codecs are the Twilio ones in `src/voice/adapters/twilio-shared.ts`; the
Go versions follow the same math sample for sample (linear interpolation,
G.711 µ-law; the phone filter is the same FFT band-pass).

## Fairness caveats

Read the numbers with these in mind.

- **Garbage collection.** Go's collector marks concurrently on other cores;
  V8 has a young generation collected on the main thread plus concurrent
  marking. Neither side's time per run excludes GC. The GC time row is not
  the same quantity on both sides: Go reports stop-the-world pauses, JS the
  main-thread time `GCProfiler` reports.
- **Allocation counts are not the same measurement.** Go's
  `testing.Benchmark` counts every heap allocation (count and bytes). JS has
  no allocation counter: "heap allocated" is the V8 used heap at the end
  minus at the start plus what every GC in between reclaimed, from
  `v8.GCProfiler`. It is close for objects and strings but leaves out
  `ArrayBuffer` backing stores (all `Uint8Array` audio, HTTP buffers), so the
  JS voice numbers undercount. JS has no allocation count column.
- **JIT warm-up.** Every timed JS measurement runs after a warm-up (30
  scenario runs; half a batch for micro benchmarks), so it shows optimized
  code. Go is compiled ahead of time; its warm-up only fills caches and
  pools. The cold start is the one place where JS pays for loading and
  compiling, by design.
- **Cores.** Go runs parallel scenarios on all cores; Node runs them on one
  event loop thread. The `GOMAXPROCS=1` rows compare one core with one core.
  The JS HTTP client (undici) and V8's GC also use helper threads.
- **The AI SDK layer.** In the `aisdk` column every model call goes through
  `generateText`: zod validation of tool inputs, prompt conversion, and two
  OpenTelemetry spans per call. Those spans are collected for the thread, so
  the JS judge also reads a larger trace digest than the Go judge. The Go
  SDK has no such layer (its providers start no spans). The `direct` column
  removes this layer.
- **Work Go does once and JS does every time.** Go caches each message's
  AG-UI JSON and each span's compiled digest for the life of a run; JS
  rebuilds the whole conversation for every MESSAGE_SNAPSHOT and the whole
  digest for every judge call. That is a real difference between the SDKs,
  not a harness artefact, and the micro tables show both "same work" and "as
  the SDK runs it" rows.
- **JS-only work per run.** `getProjectConfig()` looks for a
  `scenario.config.*` file in the working directory; the logger's debug
  calls build their argument objects even when debug is off; `run()`
  validates the environment with zod.
- **Buffers in the audio paths.** Go's `Append*` functions write into a
  reused buffer, the way the Go adapters call them; the JS functions return
  a new `Uint8Array` each call. Packet loss draws random numbers (Go seeded,
  JS `Math.random`), so which windows are zeroed differs; the work does not.
- **HTTP stacks.** Both sinks run in the measured process, so their cost is
  in the numbers: Go's `net/http` server and keep-alive client against
  Node's `http` server and `fetch` (undici). Posting events is part of what
  each SDK does per run.
- **Build.** The JS internals bundle is built separately from `dist` (same
  esbuild, target node20); the code is the same source.

## Files

```
run.sh                       one command: checks load, builds, runs, reports
go/                          Go module (replace directives point at ../../../go)
  fake/                      scripted LLM, agent under test, event sink, run setup
  cmd/coldstart/             cold start binary
  cmd/scenario/              full scenario: timing, alloc, parallel phases
  voicebench/                voice benchmarks (go test -bench)
  stats/                     median, p95, peak RSS
inpkg/zz_govsjs_bench_test.go  AG-UI and event encoding benchmarks, copied into go/ for the build
js/
  lib/                       module resolution, fake model, sink, setup, stats, bench loop
  coldstart.mjs, .cjs        cold start, ESM and CJS
  coldstart-driver.mjs       spawns and times the cold starts
  scenario.mjs               full scenario: timing, alloc, parallel phases
  micro.mjs, voice.mjs       micro and voice benchmarks
  build-internals.mjs        bundles the JS internals the micro benchmarks need
  report.mjs                 raw results to results.md
results/raw/                 raw JSON and go test output of the last run
results.md                   the report
```
