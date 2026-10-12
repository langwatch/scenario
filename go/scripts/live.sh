#!/usr/bin/env bash
# Runs the Go SDK live suite: the integration-tagged tests that talk to real
# providers and a real LangWatch project. Every test skips, naming the
# missing environment variable, when its keys are absent; the summary at the
# end lists what passed, failed and was skipped (and why).
#
# Usage:
#   go/scripts/live.sh                      # every module
#   go/scripts/live.sh providers/openai live  # some modules (paths under go/)
#
# Environment:
#   SCENARIO_LIVE_RUN      test pattern (default: Live)
#   SCENARIO_LIVE_TIMEOUT  go test timeout per module (default: 30m)
#   plus the provider keys the tests read: OPENAI_API_KEY, ANTHROPIC_API_KEY,
#   GEMINI_API_KEY, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, LANGWATCH_API_KEY,
#   ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, PIPECAT_URL, TWILIO_* with
#   SCENARIO_LIVE_TWILIO=1, NGROK_AUTHTOKEN, SCENARIO_TUNNEL_E2E=1.
set -uo pipefail

GO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="${SCENARIO_LIVE_RUN:-Live}"
TIMEOUT="${SCENARIO_LIVE_TIMEOUT:-30m}"

if [ "$#" -gt 0 ]; then
  MODULES=("$@")
else
  MODULES=(
    .
    providers/openai
    providers/anthropic
    providers/gemini
    providers/bedrock
    voice
    voice/tunnel/ngrok
    live
  )
fi

LOG_DIR="$(mktemp -d)"
SUMMARY="$LOG_DIR/summary.txt"
: >"$SUMMARY"
failed_modules=()

# summarize prints one line per finished test of a verbose go test log:
# "PASS|FAIL|SKIP <module> <test> [(<reason>)]". The reason of a skip is the
# last line the test logged, tracked per test since go test prints subtest
# results after their parent finished.
summarize() {
  awk -v module="$1" '
    /^=== (RUN|CONT|NAME|PAUSE) / { current = $3; next }
    /^[[:space:]]+[^[:space:]]+\.go:[0-9]+: / {
      line = $0
      sub(/^[[:space:]]+[^[:space:]]+\.go:[0-9]+: /, "", line)
      if (current != "") reason[current] = line
      next
    }
    /^[[:space:]]*--- (PASS|FAIL|SKIP): / {
      status = $2; sub(/:$/, "", status)
      name = $3
      if (status == "SKIP") printf "SKIP  %-22s %s  (%s)\n", module, name, reason[name]
      else printf "%s  %-22s %s\n", status, module, name
    }
  ' "$2"
}

for module in "${MODULES[@]}"; do
  dir="$GO_DIR/$module"
  if [ ! -f "$dir/go.mod" ]; then
    echo "!! $module is not a Go module under go/" >&2
    failed_modules+=("$module")
    continue
  fi
  log="$LOG_DIR/$(echo "$module" | tr '/.' '__').log"
  echo "==> $module: go test -tags integration -run $RUN -count=1 -p 1 ./..."
  (cd "$dir" && go test -tags integration -run "$RUN" -count=1 -p 1 -timeout "$TIMEOUT" -v ./...) 2>&1 | tee "$log"
  if [ "${PIPESTATUS[0]}" -ne 0 ]; then
    failed_modules+=("$module")
  fi
  label="$module"
  [ "$module" = "." ] && label="go"
  summarize "$label" "$log" >>"$SUMMARY"
done

# Only the live tests (named TestLive... or ...Live) and their subtests go
# into the summary; unit tests the pattern happens to match stay in the logs.
live_lines="$(grep -E '^(PASS|FAIL|SKIP) +[^ ]+ +Test(Live[^ /]*|[^ /]*Live)(/[^ ]*)?( |$)' "$SUMMARY" || true)"

echo
echo "================ Go live suite ================"
for status in PASS FAIL SKIP; do
  lines="$(printf '%s\n' "$live_lines" | grep "^$status " || true)"
  count="$(printf '%s' "$lines" | grep -c . || true)"
  echo "$status: $count"
  [ -n "$lines" ] && printf '%s\n' "$lines" | sed 's/^/  /'
done
echo
echo "Suites skipped for missing keys or opt-ins:"
skipped="$(printf '%s\n' "$live_lines" | awk '$1 == "SKIP" && $3 !~ /\// { sub(/^SKIP  /, "  "); print }')"
printf '%s\n' "${skipped:-  none}"
echo "Logs: $LOG_DIR"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Go live suite"
    echo
    echo '```'
    printf '%s\n' "$live_lines"
    echo '```'
  } >>"$GITHUB_STEP_SUMMARY"
fi

if [ "${#failed_modules[@]}" -gt 0 ]; then
  echo "Failed modules: ${failed_modules[*]}" >&2
  exit 1
fi
