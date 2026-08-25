#!/usr/bin/env bash
# Drives scripts/ci/examples-suite-gate.sh through every outcome it classifies.
#
# The gate decides whether a required check goes red, so the case that matters
# most is the one where it must NOT be lenient: a real failure, and a budget
# outage on a pull request that changes the examples. A gate that tolerates
# everything reads exactly like a gate that tolerates the right things.
#
# Exit codes: 0 = all pass, 1 = one or more failures.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/ci/examples-suite-gate.sh"
FAIL=0
CHECKS=0

pass() { echo "  PASS: $1"; CHECKS=$((CHECKS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=1; CHECKS=$((CHECKS + 1)); }

BUDGET_OUTPUT='examples/test_foo.py::test_bar FAILED
openai.PermissionDeniedError: Error code: 402 - {"error": {"message": "budget exceeded", "code": "budget_exceeded", "meta": {"budget_scope": "virtual_key"}}}'

# run_case <label> <touched> <exit code the suite returns> <suite stdout> <expected gate exit>
#
# Nothing is returned on stdout: an earlier version handed the temp path back
# that way, and capturing it with $(...) swallowed every PASS and FAIL line
# this function printed. Six cases ran and reported nothing while the summary
# still said all checks passed, which is why CHECKS is asserted at the end.
run_case() {
  local label="$1" touched="$2" suite_status="$3" suite_output="$4" want="$5"
  local summary log got
  summary="$(mktemp)"
  log="$(mktemp)"

  EXAMPLES_TOUCHED="$touched" GITHUB_STEP_SUMMARY="$summary" \
    bash "$GATE" bash -c "printf '%s\n' \"\$0\"; exit $suite_status" "$suite_output" \
    >"$log" 2>&1
  got=$?

  if [ "$got" -eq "$want" ]; then
    pass "$label (exit $got)"
  else
    fail "$label: expected exit $want, got $got"
    sed 's/^/      /' "$log"
  fi
  rm -f "$summary" "$log"
}

echo "=== the suite passes ==="
run_case "a passing suite passes, whatever else is true" false 0 "1219 passed" 0
run_case "a passing suite passes when the PR touches examples" true 0 "1219 passed" 0

echo ""
echo "=== the suite fails for its own reasons ==="
run_case "a real failure stays red" false 1 "examples/test_foo.py::test_bar FAILED
AssertionError: expected 'hello' to equal 'goodbye'" 1
run_case "a real failure stays red when the PR touches examples" true 1 "AssertionError: nope" 1

echo ""
echo "=== the shared budget is exhausted ==="
run_case "tolerated when the PR touches nothing the suite covers" false 1 "$BUDGET_OUTPUT" 0
run_case "NOT tolerated when the PR changes the examples" true 1 "$BUDGET_OUTPUT" 1

echo ""
echo "=== the reason survives the log ==="
SUMMARY="$(mktemp)"
EXAMPLES_TOUCHED=false GITHUB_STEP_SUMMARY="$SUMMARY" \
  bash "$GATE" bash -c "printf '%s\n' \"\$0\"; exit 1" "$BUDGET_OUTPUT" >/dev/null 2>&1
if grep -q "budget" "$SUMMARY"; then
  pass "a tolerated outage still writes the run summary"
else
  fail "a tolerated outage wrote no run summary, so the only signal is a warning nobody reads"
fi
if grep -qi "not run\|unverified" "$SUMMARY"; then
  pass "the summary says the suite did not run, rather than implying it passed"
else
  fail "the summary does not say the suite failed to run"
fi
rm -f "$SUMMARY"

echo ""
echo "=== the gate refuses what it cannot classify ==="
if EXAMPLES_TOUCHED=false bash "$GATE" >/dev/null 2>&1; then
  fail "the gate accepted an empty command"
else
  pass "the gate rejects an empty command"
fi
if ( unset EXAMPLES_TOUCHED; bash "$GATE" true >/dev/null 2>&1 ); then
  fail "the gate ran without EXAMPLES_TOUCHED, so it would silently pick a branch"
else
  pass "the gate refuses to run without EXAMPLES_TOUCHED"
fi

echo ""
# A harness that runs nothing prints the same happy line as one that runs
# everything. This is what makes the line above mean something.
EXPECTED_CHECKS=10
if [ "$CHECKS" -ne "$EXPECTED_CHECKS" ]; then
  echo "  FAIL: ran $CHECKS checks, expected $EXPECTED_CHECKS; the harness is not running what it claims"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "All $CHECKS examples-budget-gate checks passed."
else
  echo "examples-budget-gate checks FAILED."
fi
exit "$FAIL"
