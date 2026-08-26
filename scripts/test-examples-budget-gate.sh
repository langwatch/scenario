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

# JUnit reports, since the gate classifies per failed test rather than by
# grepping the log. A budget outage and a real failure can land in the same
# run, and only a per-test report can tell them apart.
report() { printf '%s\n' "$1" >"$2"; }

PASSING_XML='<testsuites><testsuite name="examples" tests="2">
  <testcase classname="examples.test_foo" name="test_bar"/>
  <testcase classname="examples.test_foo" name="test_baz"/>
</testsuite></testsuites>'

BUDGET_XML='<testsuites><testsuite name="examples" tests="2" failures="2">
  <testcase classname="examples.test_foo" name="test_bar">
    <failure message="openai.PermissionDeniedError: Error code: 402 - {&quot;error&quot;: {&quot;code&quot;: &quot;budget_exceeded&quot;, &quot;meta&quot;: {&quot;budget_scope&quot;: &quot;virtual_key&quot;}}}">402</failure>
  </testcase>
  <testcase classname="examples.test_foo" name="test_baz">
    <failure message="Error code: 402 budget_exceeded">402</failure>
  </testcase>
</testsuite></testsuites>'

REAL_XML='<testsuites><testsuite name="examples" tests="1" failures="1">
  <testcase classname="examples.test_foo" name="test_bar">
    <failure message="AssertionError">expected hello to equal goodbye</failure>
  </testcase>
</testsuite></testsuites>'

# The case this gate must never wave through: the gateway refused most tests on
# budget AND one example is genuinely broken.
MIXED_XML='<testsuites><testsuite name="examples" tests="2" failures="2">
  <testcase classname="examples.test_foo" name="test_bar">
    <failure message="Error code: 402 budget_exceeded">402</failure>
  </testcase>
  <testcase classname="examples.test_other" name="test_broken">
    <failure message="AssertionError">expected hello to equal goodbye</failure>
  </testcase>
</testsuite></testsuites>'

# A report is only ever written by pytest or vitest, neither of which emits a
# doctype. One appearing means something else wrote the file, and an internal
# entity definition is how a small report expands to gigabytes while the gate
# waits for it.
DOCTYPE_XML='<?xml version="1.0"?><!DOCTYPE testsuites [<!ENTITY a "aaaaaaaaaa">]>
<testsuites><testsuite name="examples" tests="1" failures="1">
  <testcase classname="examples.test_foo" name="test_bar">
    <failure message="Error code: 402 budget_exceeded">&a;</failure>
  </testcase>
</testsuite></testsuites>'

NO_FAILURES_XML='<testsuites><testsuite name="examples" tests="1"><testcase classname="e" name="t"/></testsuite></testsuites>'

# run_case <label> <touched> <suite exit code> <junit xml> <expected gate exit>
#
# Nothing is returned on stdout: an earlier version handed the temp path back
# that way, and capturing it with $(...) swallowed every PASS and FAIL line
# this function printed. Six cases ran and reported nothing while the summary
# still said all checks passed, which is why CHECKS is asserted at the end.
run_case() {
  local label="$1" touched="$2" suite_status="$3" xml="$4" want="$5"
  local summary log junit got
  summary="$(mktemp)"
  log="$(mktemp)"
  junit="$(mktemp)"
  report "$xml" "$junit"

  EXAMPLES_TOUCHED="$touched" EXAMPLES_REPORT="$junit" GITHUB_STEP_SUMMARY="$summary" \
    bash "$GATE" bash -c "exit $suite_status" \
    >"$log" 2>&1
  got=$?

  if [ "$got" -eq "$want" ]; then
    pass "$label (exit $got)"
  else
    fail "$label: expected exit $want, got $got"
    sed 's/^/      /' "$log"
  fi
  rm -f "$summary" "$log" "$junit"
}

echo "=== the suite passes ==="
run_case "a passing suite passes, whatever else is true" false 0 "$PASSING_XML" 0
run_case "a passing suite passes when the PR touches examples" true 0 "$PASSING_XML" 0

echo ""
echo "=== the suite fails for its own reasons ==="
run_case "a real failure stays red" false 1 "$REAL_XML" 1
run_case "a real failure stays red when the PR touches examples" true 1 "$REAL_XML" 1

echo ""
echo "=== budget refusals mixed with a real failure ==="
# The whole point of classifying per test. Deciding on "the output mentions the
# budget somewhere" would let the broken example through.
run_case "a mixed run stays red even when the PR touches nothing" false 1 "$MIXED_XML" 1
run_case "a mixed run stays red when the PR touches examples" true 1 "$MIXED_XML" 1

echo ""
echo "=== the shared budget is exhausted, and nothing else failed ==="
run_case "tolerated when the PR touches nothing the suite covers" false 1 "$BUDGET_XML" 0
run_case "NOT tolerated when the PR changes the examples" true 1 "$BUDGET_XML" 1

echo ""
echo "=== the gate cannot verify the claim ==="
run_case "a report listing no failure is not a budget outage" false 1 "$NO_FAILURES_XML" 1
run_case "an unreadable report is not a budget outage" false 1 "not xml at all" 1

echo ""
echo "=== a mixed run says WHICH failure is not the budget ==="
# The case arm for "mixed" would otherwise be free to disappear: the gate's
# case statement is fail-closed, so a missing arm still exits red via the
# default. What that costs is the diagnostic, and the diagnostic is the whole
# actionable part, so it is asserted rather than assumed.
MIXED_LOG="$(mktemp)"
MIXED_JUNIT="$(mktemp)"
report "$MIXED_XML" "$MIXED_JUNIT"
EXAMPLES_TOUCHED=false EXAMPLES_REPORT="$MIXED_JUNIT" GITHUB_STEP_SUMMARY=/dev/null \
  bash "$GATE" bash -c "exit 1" >"$MIXED_LOG" 2>&1
if grep -q "test_broken" "$MIXED_LOG"; then
  pass "the mixed verdict names the failing test"
else
  fail "the mixed verdict does not name the failing test, so the log says only that something is wrong"
  sed 's/^/      /' "$MIXED_LOG"
fi
if grep -qi "not gateway budget refusals\|does not excuse" "$MIXED_LOG"; then
  pass "the mixed verdict explains that a budget outage does not excuse it"
else
  fail "the mixed verdict does not explain itself"
fi
rm -f "$MIXED_LOG" "$MIXED_JUNIT"

echo ""
echo "=== the reason survives the log ==="
SUMMARY="$(mktemp)"
JUNIT="$(mktemp)"
report "$BUDGET_XML" "$JUNIT"
EXAMPLES_TOUCHED=false EXAMPLES_REPORT="$JUNIT" GITHUB_STEP_SUMMARY="$SUMMARY" \
  bash "$GATE" bash -c "exit 1" >/dev/null 2>&1
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
rm -f "$SUMMARY" "$JUNIT"

echo ""
echo "=== the report is not the one the test runner wrote ==="
# Fail closed rather than trusting it. The budget branch is the lenient one, so
# a report the gate cannot vouch for must never reach it.
run_case "a report carrying a doctype is not a budget outage" false 1 "$DOCTYPE_XML" 1

# Built rather than inlined: the point is the size, and a 17MB shell variable
# is its own problem.
echo ""
echo "=== the report is too large to be one ==="
BIG_JUNIT="$(mktemp)"
BIG_LOG="$(mktemp)"
{
  printf '%s' '<testsuites><testsuite name="examples" tests="1" failures="1"><testcase classname="e" name="t"><failure message="budget_exceeded">'
  head -c 17000000 /dev/zero | tr '\0' 'a'
  printf '%s' '</failure></testcase></testsuite></testsuites>'
} >"$BIG_JUNIT"
EXAMPLES_TOUCHED=false EXAMPLES_REPORT="$BIG_JUNIT" GITHUB_STEP_SUMMARY=/dev/null \
  bash "$GATE" bash -c "exit 1" >"$BIG_LOG" 2>&1
BIG_STATUS=$?
if [ "$BIG_STATUS" -eq 0 ]; then
  fail "an oversized report was tolerated as a budget outage"
  sed 's/^/      /' "$BIG_LOG"
else
  pass "an oversized report is not a budget outage"
fi
# The verdict alone does not reach the size check: the read is already bounded,
# so dropping the check leaves a truncated document that fails to parse and is
# refused anyway. What it costs is knowing WHY, and "the report is larger than
# it can be" and "the report is malformed" send a maintainer to different
# places. So the diagnostic is what is asserted here.
if grep -q "larger than" "$BIG_LOG"; then
  pass "an oversized report is reported as oversized, not as malformed"
else
  fail "an oversized report is reported as a parse error, which points at the wrong problem"
  sed 's/^/      /' "$BIG_LOG"
fi
rm -f "$BIG_JUNIT" "$BIG_LOG"

echo ""
echo "=== the gate refuses what it cannot classify ==="
if EXAMPLES_TOUCHED=false EXAMPLES_REPORT=/dev/null bash "$GATE" >/dev/null 2>&1; then
  fail "the gate accepted an empty command"
else
  pass "the gate rejects an empty command"
fi
if ( unset EXAMPLES_TOUCHED; EXAMPLES_REPORT=/dev/null bash "$GATE" true >/dev/null 2>&1 ); then
  fail "the gate ran without EXAMPLES_TOUCHED, so it would silently pick a branch"
else
  pass "the gate refuses to run without EXAMPLES_TOUCHED"
fi
if ( unset EXAMPLES_REPORT; EXAMPLES_TOUCHED=false bash "$GATE" true >/dev/null 2>&1 ); then
  fail "the gate ran without EXAMPLES_REPORT, so it would decide with nothing to classify"
else
  pass "the gate refuses to run without EXAMPLES_REPORT"
fi

# `false` and anything-that-is-not-true both take the lenient branch, so a typo
# or a mis-wired filter key would tolerate an outage on a PR that does change
# the examples. Only the two real answers are accepted.
for bad in tru True yes 1; do
  if EXAMPLES_TOUCHED="$bad" EXAMPLES_REPORT=/dev/null bash "$GATE" true >/dev/null 2>&1; then
    fail "the gate accepted EXAMPLES_TOUCHED='$bad', which it would have read as 'examples not changed'"
  else
    pass "the gate rejects EXAMPLES_TOUCHED='$bad' rather than reading it as false"
  fi
done

echo ""
# A harness that runs nothing prints the same happy line as one that runs
# everything. This is what makes the line above mean something.
EXPECTED_CHECKS=24
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
