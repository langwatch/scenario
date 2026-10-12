# Go vs JS SDK benchmark results

Generated 2026-10-12T18:45:03.643Z by benchmarks/go-vs-js/run.sh. Method and caveats: README.md.

| Environment |  |
|---|---:|
| Machine | Darwin 27.0.0 arm64, 10 × Apple M1 Max, 65,536 MiB RAM |
| Go | go1.27.1 (GOMAXPROCS 10) |
| Node | v24.21.0 |
| Commit | 7ea2329e |
| Settings | `REPS=40 WARMUP=30 RUNS=200 ALLOC_RUNS=100 PAR_LEVELS="1 8 32" PAR_TOTAL=256 BENCH_COUNT=5 BENCHTIME=1s QUICK=0 FORCE=1` |
| Load at start | `20:37  up 1 day,  3:09, 3 users, load averages: 7.63 10.11 12.17` |
| Load at end | `20:45  up 1 day,  3:16, 3 users, load averages: 9.50 10.90 11.83` |

> **WARNING: the 1-minute load average at the start was 7.63, above 4. These numbers are not trustworthy.**

> **WARNING: the 1-minute load average at the end was 9.5, above 4. These numbers are not trustworthy.**

Ratios are JS ÷ Go: above 1× means JS takes longer or uses more; for throughput, Go ÷ JS.

## 1. Cold start

Whole process, 40 interleaved repetitions: start, set up tracing, run the trivial scenario (scripted user message, fixed agent answer, succeed), exit.

|  | wall median | wall p95 | ÷ Go | peak RSS median | ÷ Go |
|---|---:|---:|---:|---:|---:|
| Go binary | 7.572 ms | 9.911 ms | 1× | 14.95 MiB | 1× |
| JS ESM (dist/index.mjs) | 446.2 ms | 594.2 ms | 58.93× | 138.03 MiB | 9.23× |
| JS CJS (dist/index.js) | 416.9 ms | 521.3 ms | 55.06× | 128.8 MiB | 8.61× |

## 2. Full scenario (10 turns, user simulator + agent + judge)

| per run | Go | JS (AI SDK) | ÷ Go | JS (invokeLLM) | ÷ Go |
|---|---:|---:|---:|---:|---:|
| time, median | 4.789 ms | 104.2 ms | 21.76× | 60 ms | 12.53× |
| time, p95 | 6.511 ms | 162.3 ms | 24.93× | 81 ms | 12.44× |
| time, mean | 5.136 ms | 114.3 ms | 22.25× | 62.2 ms | 12.11× |
| heap allocated | 3.53 MiB | 88.02 MiB | 24.94× | 49.57 MiB | 14.05× |
| allocations (count) | 9,276 | n/a |  | n/a |  |
| retained after GC | 503 B | 373.5 KiB | 761.05× | 237.2 KiB | 483.41× |
| garbage collections | 3.74 | 1.54 | 0.41× | 1.06 | 0.28× |
| GC time (Go: STW pauses; JS: main thread) | 0.313 ms | 3.542 ms | 11.31× | 2.788 ms | 8.9× |
| events posted | 42 | 42 | 1× | 42 | 1× |
| event bytes posted | 184.2 KiB | 187 KiB | 1.02× | 184.2 KiB | 1× |
| messages | 40 | 40 | 1× | 40 | 1× |
| spans exported | 61 | 81 | 1.33× | 41 | 0.67× |
| AI SDK warnings dropped, not printed | n/a | 20 | n/a | 0 | n/a |

Events, messages and spans are a parity check: messages and events must match. Spans differ by design: both SDKs export the run, turn and agent call spans (41); Go adds one chat span per user simulator and judge model call (20), the AI SDK two (40), and the invokeLLM column none. Event bytes differ a little in the AI SDK column because the AI SDK returns the agent's answer as a list of text parts rather than a string (see README.md).

### Throughput with N parallel scenarios

Go runs N goroutines on all cores (and, for a like-for-like single-thread view, with GOMAXPROCS=1); JS runs N concurrent promises on its one event loop thread.

| N | Go runs/s | Go 1 core runs/s | JS (AI SDK) runs/s | JS (invokeLLM) runs/s | Go ÷ JS (AI SDK) | Go 1 core ÷ JS (AI SDK) | Go 1 core ÷ JS (invokeLLM) |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 217.4 | 155.6 | 9.3 | 16 | 23.32× | 16.68× | 9.71× |
| 8 | 527.5 | 277 | 9.7 | 16.9 | 54.53× | 28.63× | 16.35× |
| 32 | 686 | 286.7 | 8.5 | 15.8 | 80.34× | 33.58× | 18.19× |

| N | Go peak RSS | Go 1 core peak RSS | JS (AI SDK) peak RSS | JS (invokeLLM) peak RSS |
|---|---:|---:|---:|---:|
| 1 | 26.95 MiB | 22.88 MiB | 910.88 MiB | 773.55 MiB |
| 8 | 40.39 MiB | 32.06 MiB | 935.42 MiB | 760.47 MiB |
| 32 | 71.22 MiB | 65.3 MiB | 950.3 MiB | 826.33 MiB |

## 3. Micro benchmarks

Median of 5 runs of about 1 s each on both sides.

|  | Go time/op | Go B/op | Go allocs/op | JS time/op | JS heap B/op | time ÷ Go | note |
|---|---:|---:|---:|---:|---:|---:|---:|
| Judge span digest, 50 spans | 192.87 µs | 117.2 KiB | 193 | 400.59 µs | 760.9 KiB | 2.08× | both build the full digest from scratch |
| Judge span digest, 50 spans, as the judge runs it | 17.1 µs | 59.3 KiB | 17 | 400.59 µs | 760.9 KiB | 23.42× | Go judge reuses each span's compiled digest; JS has no cache |
| Structure-only digest, 50 spans | 15.62 µs | 11.1 KiB | 9 | 47.15 µs | 66 KiB | 3.02× |  |
| AG-UI conversion, 20 messages | 2.61 µs | 3 KiB | 20 | 129.5 ns | 1.6 KiB | 0.05× | Go writes JSON rows; JS builds objects |
| MESSAGE_SNAPSHOT body, 20 messages, from scratch | 7.03 µs | 5.2 KiB | 21 | 3.34 µs | 3.7 KiB | 0.47× | convert + envelope + JSON on both |
| MESSAGE_SNAPSHOT body, 20 messages, as the SDK runs it | 728.9 ns | 2.7 KiB | 2 | 3.34 µs | 3.7 KiB | 4.58× | Go caches each message's JSON per run; JS redoes it per event |

## 4. Voice audio paths

Go appends into a reused buffer (its adapters' hot path); JS allocates a new Uint8Array per call, whose bytes live outside the V8 heap and so are not in "JS heap B/op".

|  | Go time/op | Go B/op | Go allocs/op | JS time/op | JS heap B/op | time ÷ Go | note |
|---|---:|---:|---:|---:|---:|---:|---:|
| µ-law encode, 20 ms at 8 kHz | 215 ns | 0 B | 0 | 1.07 µs | 290 B | 5× |  |
| µ-law decode, 20 ms at 8 kHz | 205.7 ns | 0 B | 0 | 1.5 µs | 289 B | 7.3× |  |
| Resample 24 kHz → 8 kHz, 20 ms | 385.6 ns | 0 B | 0 | 1.54 µs | 394 B | 4× |  |
| Resample 8 kHz → 24 kHz, 20 ms | 1.45 µs | 0 B | 0 | 8.36 µs | 394 B | 5.75× |  |
| PCM16 24 kHz → µ-law 8 kHz (Twilio out), 20 ms | 161.1 ns | 0 B | 0 | 2.97 µs | 682 B | 18.46× |  |
| µ-law 8 kHz → PCM16 24 kHz (Twilio in), 20 ms | 1.04 µs | 0 B | 0 | 9.75 µs | 682 B | 9.36× |  |
| Effect chain (noise, phone, packet loss), 20 ms | 19.2 µs | 0 B | 0 | 32.15 µs | 36.2 KiB | 1.67× |  |
| Effect chain (noise, phone, packet loss), 1 s | 2.49 ms | 0 B | 0 | 2.69 ms | 2.11 MiB | 1.08× |  |
