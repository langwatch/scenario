#!/usr/bin/env bash
# Go vs JS SDK benchmark: builds what it needs, runs every part on this
# machine and writes results.md next to this script. See README.md.
#
#   benchmarks/go-vs-js/run.sh            full run (about 20-30 minutes)
#   QUICK=1 benchmarks/go-vs-js/run.sh    smoke run with tiny counts
#
# Settings (environment): MAX_LOAD (4), FORCE (0: refuse when the 1-minute
# load average is above MAX_LOAD), ONLY (subset of: coldstart scenario
# parallel micro voice), REPS, WARMUP, RUNS, ALLOC_RUNS, PAR_LEVELS,
# PAR_TOTAL, BENCH_COUNT, BENCHTIME, SKIP_JS_BUILD, SCENARIO_JS_DIR.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
JS_DIR="${SCENARIO_JS_DIR:-$REPO/javascript}"
GO_SDK="$REPO/go"
RESULTS="$HERE/results"
RAW="$RESULTS/raw"
BIN="$RESULTS/bin"
OUT="$HERE/results.md"

MAX_LOAD="${MAX_LOAD:-4}"
FORCE="${FORCE:-0}"
ONLY="${ONLY:-coldstart scenario parallel micro voice}"
if [ "${QUICK:-0}" = 1 ]; then
  REPS="${REPS:-5}" WARMUP="${WARMUP:-3}" RUNS="${RUNS:-10}" ALLOC_RUNS="${ALLOC_RUNS:-5}"
  PAR_LEVELS="${PAR_LEVELS:-1 8}" PAR_TOTAL="${PAR_TOTAL:-16}"
  BENCH_COUNT="${BENCH_COUNT:-2}" BENCHTIME="${BENCHTIME:-200ms}"
else
  REPS="${REPS:-40}" WARMUP="${WARMUP:-30}" RUNS="${RUNS:-200}" ALLOC_RUNS="${ALLOC_RUNS:-100}"
  PAR_LEVELS="${PAR_LEVELS:-1 8 32}" PAR_TOTAL="${PAR_TOTAL:-256}"
  BENCH_COUNT="${BENCH_COUNT:-5}" BENCHTIME="${BENCHTIME:-1s}"
fi
# The JS micro loop mirrors -benchtime: one batch per Go run, same length.
case "$BENCHTIME" in
  *ms) BENCH_BATCH_MS="${BENCHTIME%ms}" ;;
  *s) BENCH_BATCH_MS="$(awk -v s="${BENCHTIME%s}" 'BEGIN{print s*1000}')" ;;
  *) echo "BENCHTIME must be like 1s or 500ms" >&2; exit 2 ;;
esac
export BENCH_COUNT BENCH_BATCH_MS

log() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
want() { case " $ONLY " in *" $1 "*) return 0 ;; esac; return 1; }

# --- load check -------------------------------------------------------------

load1() { uptime | sed -E 's/.*load averages?: *//' | awk -F'[ ,]+' '{print $1}'; }
above() { awk -v l="$1" -v m="$2" 'BEGIN { exit !(l > m) }'; }

L="$(load1)"
if above "$L" "$MAX_LOAD"; then
  if [ "$FORCE" = 1 ]; then
    printf '\n%s\n%s\n%s\n\n' \
      "############################################################" \
      "WARNING: 1-minute load average is $L (> $MAX_LOAD). Results will be noisy." \
      "############################################################" >&2
  else
    echo "Refusing to run: the 1-minute load average is $L, above $MAX_LOAD." >&2
    echo "Wait for a quiet machine, or set FORCE=1 to run anyway (results.md will carry a warning)." >&2
    exit 2
  fi
fi

for tool in go node; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done

# --- environment shared by both SDKs ----------------------------------------

# No LangWatch credentials: events go only to the local sink, which each
# program passes explicitly; nothing is exported to LangWatch.
unset LANGWATCH_API_KEY LANGWATCH_ENDPOINT LANGWATCH_PROJECT_ID SCENARIO_BATCH_RUN_ID \
  SCENARIO_SEND_GRANULAR_EVENTS SCENARIO_LOG_LEVEL NODE_ENV NODE_OPTIONS || true
export SCENARIO_BROWSER=never SCENARIO_HEADLESS=1 SCENARIO_DISABLE_SIMULATION_REPORT_INFO=1 LOG_LEVEL=error
export GOWORK=off SCENARIO_JS_DIR="$JS_DIR"

rm -rf "$RAW" "$BIN"
mkdir -p "$RAW" "$BIN"
uptime >"$RAW/uptime-start.txt"
cat >"$RAW/run-config.txt" <<EOF
REPS=$REPS WARMUP=$WARMUP RUNS=$RUNS ALLOC_RUNS=$ALLOC_RUNS PAR_LEVELS="$PAR_LEVELS" PAR_TOTAL=$PAR_TOTAL BENCH_COUNT=$BENCH_COUNT BENCHTIME=$BENCHTIME QUICK=${QUICK:-0} FORCE=$FORCE
EOF

# --- build --------------------------------------------------------------------

INPKG="$GO_SDK/zz_govsjs_bench_test.go"
cleanup() { rm -f "$INPKG"; }
trap cleanup EXIT

log "building the JS SDK ($JS_DIR)"
if [ ! -d "$JS_DIR/node_modules" ]; then
  command -v pnpm >/dev/null || { echo "pnpm is required to install javascript/node_modules" >&2; exit 2; }
  echo "javascript/node_modules is missing: installing the locked dependencies first"
  (cd "$JS_DIR" && pnpm install --frozen-lockfile)
fi
if [ "${SKIP_JS_BUILD:-0}" != 1 ]; then
  command -v pnpm >/dev/null || { echo "pnpm is required to build the JS SDK (or set SKIP_JS_BUILD=1)" >&2; exit 2; }
  (cd "$JS_DIR" && pnpm run build)
fi
node "$HERE/js/build-internals.mjs"

log "building the Go programs and benchmark binaries"
(cd "$HERE/go" && go build -o "$BIN/coldstart" ./cmd/coldstart && go build -o "$BIN/scenario" ./cmd/scenario)
(cd "$HERE/go" && go test -c -o "$BIN/voicebench.test" ./voicebench)
cp "$HERE/inpkg/zz_govsjs_bench_test.go" "$INPKG"
(cd "$GO_SDK" && go test -c -o "$BIN/inpkg.test" .)
rm -f "$INPKG"
(cd "$GO_SDK" && go test -c -o "$BIN/spandigest.test" ./internal/spandigest)

NODE=(node --expose-gc)
gobench() { # dir binary regex output
  (cd "$1" && "$2" -test.run '^$' -test.bench "$3" -test.benchmem \
    -test.count "$BENCH_COUNT" -test.benchtime "$BENCHTIME") | tee "$4"
}

# --- 1. cold start --------------------------------------------------------------

if want coldstart; then
  log "1. cold start ($REPS repetitions each)"
  node "$HERE/js/coldstart-driver.mjs" --go-bin="$BIN/coldstart" --reps="$REPS" --out="$RAW/coldstart.json"
fi

# --- 2. full scenario ------------------------------------------------------------

if want scenario; then
  log "2. full scenario: time per run (warmup $WARMUP, runs $RUNS)"
  "$BIN/scenario" -phase timing -warmup "$WARMUP" -runs "$RUNS" -out "$RAW/go-timing.json"
  for mode in aisdk direct; do
    "${NODE[@]}" "$HERE/js/scenario.mjs" --phase=timing --mode="$mode" --warmup="$WARMUP" --runs="$RUNS" \
      --out="$RAW/js-$mode-timing.json"
  done

  log "2. full scenario: allocations and heap ($ALLOC_RUNS runs)"
  "$BIN/scenario" -phase alloc -warmup "$WARMUP" -runs "$ALLOC_RUNS" -out "$RAW/go-alloc.json"
  for mode in aisdk direct; do
    "${NODE[@]}" "$HERE/js/scenario.mjs" --phase=alloc --mode="$mode" --warmup="$WARMUP" --runs="$ALLOC_RUNS" \
      --out="$RAW/js-$mode-alloc.json"
  done
fi

if want parallel; then
  PW=$(( WARMUP < 10 ? WARMUP : 10 ))
  for n in $PAR_LEVELS; do
    log "2. throughput: $n parallel scenarios, $PAR_TOTAL runs"
    "$BIN/scenario" -phase parallel -warmup "$PW" -par "$n" -total "$PAR_TOTAL" -out "$RAW/go-parallel-$n.json"
    GOMAXPROCS=1 "$BIN/scenario" -phase parallel -warmup "$PW" -par "$n" -total "$PAR_TOTAL" -out "$RAW/go-p1-parallel-$n.json"
    for mode in aisdk direct; do
      "${NODE[@]}" "$HERE/js/scenario.mjs" --phase=parallel --mode="$mode" --warmup="$PW" --par="$n" --total="$PAR_TOTAL" \
        --out="$RAW/js-$mode-parallel-$n.json"
    done
  done
fi

# --- 3. micro ----------------------------------------------------------------------

if want micro; then
  log "3. micro: Go (AG-UI, event encoding, span digest)"
  gobench "$GO_SDK" "$BIN/inpkg.test" 'GoVsJS' "$RAW/go-micro.txt"
  gobench "$GO_SDK/internal/spandigest" "$BIN/spandigest.test" '^Benchmark(DigestFormat50|CachedDigestFormat50|DigestStructureOnly50)$' "$RAW/go-digest.txt"
  log "3. micro: JS"
  "${NODE[@]}" "$HERE/js/micro.mjs" --out="$RAW/js-micro.json"
fi

# --- 4. voice ----------------------------------------------------------------------

if want voice; then
  log "4. voice audio paths: Go"
  gobench "$HERE/go/voicebench" "$BIN/voicebench.test" '^BenchmarkVoice' "$RAW/go-voice.txt"
  log "4. voice audio paths: JS"
  "${NODE[@]}" "$HERE/js/voice.mjs" --out="$RAW/js-voice.json"
fi

# --- report ------------------------------------------------------------------------

uptime >"$RAW/uptime-end.txt"
L_END="$(load1)"
if above "$L_END" "$MAX_LOAD"; then
  echo "WARNING: the 1-minute load average rose to $L_END during the run (> $MAX_LOAD)." >&2
fi
GIT_REV="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git -C "$REPO" status --porcelain -- go javascript 2>/dev/null)" ]; then GIT_REV="$GIT_REV (+ local changes)"; fi
node "$HERE/js/report.mjs" --raw="$RAW" --out="$OUT" --git="$GIT_REV" --max-load="$MAX_LOAD" --par="${PAR_LEVELS// /,}"
log "done: $OUT"
