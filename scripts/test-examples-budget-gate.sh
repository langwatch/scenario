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

# The gate now reports its verdict on the pull request. This harness runs in
# CI, where GITHUB_REPOSITORY, GITHUB_TOKEN and GITHUB_EVENT_PATH are all set
# and real, so every invocation below is stripped of them: a synthetic budget
# outage must never leave a comment on the pull request that is running these
# tests. Two independent reasons then stop it, the missing repository and the
# missing event payload, because one guard is one edit away from being gone.
gate() {
  env -u GITHUB_REPOSITORY -u GITHUB_TOKEN -u GH_TOKEN -u GITHUB_EVENT_PATH \
    -u GITHUB_WORKFLOW "$@"
}

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

  gate EXAMPLES_TOUCHED="$touched" EXAMPLES_REPORT="$junit" GITHUB_STEP_SUMMARY="$summary" \
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
gate EXAMPLES_TOUCHED=false EXAMPLES_REPORT="$MIXED_JUNIT" GITHUB_STEP_SUMMARY=/dev/null \
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
REPORTER_LOG="$(mktemp)"
report "$BUDGET_XML" "$JUNIT"
gate EXAMPLES_TOUCHED=false EXAMPLES_REPORT="$JUNIT" GITHUB_STEP_SUMMARY="$SUMMARY" \
  bash "$GATE" bash -c "exit 1" >"$REPORTER_LOG" 2>&1
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

# The condition #944 was approved on: a tolerated outage turns a required check
# GREEN having run nothing, and the warning and the run summary both live in
# the Actions UI. The reporter is what puts it where a reviewer reads. It
# declines here because the harness strips the Actions environment, and that
# decline is the observable proof the gate reached it at all.
if grep -q "examples-suite comment not posted" "$REPORTER_LOG"; then
  pass "a tolerated outage reaches the pull-request reporter"
else
  fail "a tolerated outage never reaches the reporter, so a green check reports nothing on the PR"
  sed 's/^/      /' "$REPORTER_LOG"
fi
rm -f "$SUMMARY" "$JUNIT" "$REPORTER_LOG"

echo ""
echo "=== the verdict reaches the pull request on every branch ==="
# Each branch reports for a different reason: the tolerated one because the
# check is green, the red one because "the shared budget is out" and "your
# example is broken" send an author to completely different places, and the
# passing one to retract a stale outage comment from an earlier attempt.
reaches_reporter() {
  local label="$1" touched="$2" suite_status="$3" xml="$4"
  local junit log
  junit="$(mktemp)"
  log="$(mktemp)"
  report "$xml" "$junit"
  gate EXAMPLES_TOUCHED="$touched" EXAMPLES_REPORT="$junit" GITHUB_STEP_SUMMARY=/dev/null \
    bash "$GATE" bash -c "exit $suite_status" >"$log" 2>&1
  if grep -q "examples-suite comment not posted" "$log"; then
    pass "$label"
  else
    fail "$label: the reporter was never called"
    sed 's/^/      /' "$log"
  fi
  rm -f "$junit" "$log"
}

reaches_reporter "a budget outage on a PR that changes examples says so on the PR" true 1 "$BUDGET_XML"
reaches_reporter "a passing suite still calls the reporter, to retract a stale outage comment" false 0 "$PASSING_XML"

# A real failure is the author's own, and the gate has nothing to add that the
# suite output does not already say. Commenting there would put a bot comment
# on every red pull request in the repository.
REAL_LOG="$(mktemp)"
REAL_JUNIT="$(mktemp)"
report "$REAL_XML" "$REAL_JUNIT"
gate EXAMPLES_TOUCHED=false EXAMPLES_REPORT="$REAL_JUNIT" GITHUB_STEP_SUMMARY=/dev/null \
  bash "$GATE" bash -c "exit 1" >"$REAL_LOG" 2>&1
if grep -q "examples-suite comment not posted" "$REAL_LOG"; then
  fail "a genuinely broken example comments on the PR, which would put a bot comment on every red run"
  sed 's/^/      /' "$REAL_LOG"
else
  pass "a genuinely broken example does not comment; the suite output already says it"
fi
rm -f "$REAL_LOG" "$REAL_JUNIT"

echo ""
echo "=== reporting can fail without changing the verdict ==="
# The reporter runs on the lenient branch, after the verdict is decided. If it
# could exit non-zero it would be able to turn a tolerated outage into a red
# check, which is the bug this whole gate exists to remove.
REPORTER="$SCRIPT_DIR/ci/comment-examples-outage.sh"
reporter_survives() {
  local label="$1"
  shift
  if echo "body" | gate "$@" bash "$REPORTER" post >/dev/null 2>&1; then
    pass "$label"
  else
    fail "$label: the reporter exited non-zero, so it can fail a build it does not decide"
  fi
}

reporter_survives "no Actions environment at all"
reporter_survives "a repository but no token" GITHUB_REPOSITORY=o/r
reporter_survives "a token but no event payload" GITHUB_REPOSITORY=o/r GITHUB_TOKEN=x
reporter_survives "an event payload that is not a pull request" GITHUB_REPOSITORY=o/r GITHUB_TOKEN=x GITHUB_EVENT_PATH=/dev/null

if echo "body" | gate bash "$REPORTER" wat >/dev/null 2>&1; then
  pass "an unknown mode is refused without failing the build"
else
  fail "an unknown mode exits non-zero, so a typo in the gate would turn a tolerated outage red"
fi

if echo "" | gate GITHUB_REPOSITORY=o/r GITHUB_TOKEN=x bash "$REPORTER" post 2>&1 | grep -q "empty body"; then
  pass "an empty body is refused rather than posted as a blank comment"
else
  fail "an empty body is not refused, so a bug upstream posts an empty comment"
fi

echo ""
echo "=== one comment per suite, edited in place ==="
# The checks above only prove the reporter declines cleanly. They say nothing
# about what it does when it CAN post, which is where the two bugs that matter
# live: a re-run appending a second comment every time the daily budget is
# still out, and javascript-ci overwriting python-ci's. Both need a `gh` that
# answers, so one is stubbed. The repository and token are deliberately
# nonsense as well, so a stub that fails to shadow the real binary still
# reaches nothing.
STUB_DIR="$(mktemp -d)"
STUB_CALLS="$(mktemp)"
STUB_BODIES="$(mktemp)"
STUB_COMMENTS="$(mktemp)"
EVENT="$(mktemp)"
echo '{"pull_request":{"number":7}}' >"$EVENT"

cat >"$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_STUB_CALLS"
# Record what was actually sent, not just that something was. A body written
# without the marker is findable by nothing, so the run after it posts a second
# comment rather than editing this one.
for arg in "$@"; do
  if [[ "$arg" == body=@* && -r "${arg#body=@}" ]]; then
    cat "${arg#body=@}" >>"$GH_STUB_BODIES"
  fi
done
if [[ "$*" == *"per_page=100"* ]]; then
  cat "$GH_STUB_COMMENTS"
fi
exit 0
STUB
chmod +x "$STUB_DIR/gh"

# report_with <existing-comments-json> <mode> <workflow>
report_with() {
  printf '%s\n' "$1" >"$STUB_COMMENTS"
  : >"$STUB_CALLS"
  : >"$STUB_BODIES"
  echo "a body" | env "PATH=$STUB_DIR:$PATH" \
    GH_STUB_CALLS="$STUB_CALLS" GH_STUB_COMMENTS="$STUB_COMMENTS" \
    GH_STUB_BODIES="$STUB_BODIES" \
    GITHUB_REPOSITORY=stub/repo GITHUB_TOKEN=stub GITHUB_EVENT_PATH="$EVENT" \
    GITHUB_WORKFLOW="$3" bash "$REPORTER" "$2" >/dev/null 2>&1
}

MARKED='[{"id":11,"body":"<!-- examples-suite-report:javascript-ci -->\n\nold text"}]'

# The listing call is `issues/7/comments?per_page=100`, so matching on the path
# alone reads a read as a write. Both writes are matched on `-F body=@`, which
# only a write carries, and the edit additionally on the comment id.
created() { grep -q "issues/7/comments -F body=@" "$STUB_CALLS"; }
edited() { grep -q "issues/comments/11 -X PATCH -F body=@" "$STUB_CALLS"; }

report_with "[]" post javascript-ci
if created && ! edited; then
  pass "with no comment yet, post creates one"
else
  fail "post did not create a comment on a pull request that has none"
  sed 's/^/      /' "$STUB_CALLS"
fi

report_with "$MARKED" post javascript-ci
if edited && ! created; then
  pass "with a comment already there, post edits it rather than appending a second"
else
  fail "post appended instead of editing, so every re-run during an outage leaves another comment"
  sed 's/^/      /' "$STUB_CALLS"
fi

report_with "[]" update-only javascript-ci
if created || edited; then
  fail "update-only wrote a comment, so a clean run announces an outage that never happened here"
  sed 's/^/      /' "$STUB_CALLS"
else
  pass "update-only creates nothing when there is nothing to retract"
fi

report_with "$MARKED" update-only javascript-ci
if edited; then
  pass "update-only retracts a stale outage comment once the suite runs"
else
  fail "update-only left a stale 'the suite did not run' comment on a run that passed"
  sed 's/^/      /' "$STUB_CALLS"
fi

# The two workflows both call this on the same pull request. Keyed on one
# marker they would take turns overwriting each other, and the surviving
# comment would name whichever suite happened to finish last.
report_with "$MARKED" post python-ci
if created && ! edited; then
  pass "a different workflow keeps its own comment rather than overwriting the other suite's"
else
  fail "python-ci overwrote javascript-ci's comment, so only the last suite to finish is reported"
  sed 's/^/      /' "$STUB_CALLS"
fi

# The round trip, which is what the checks above do not reach: they all seed a
# fixture that already carries the marker, so a reporter writing a body without
# one still finds and edits it. Only the NEXT run breaks, posting a second
# comment. So what was written is checked for the marker the next run looks up.
report_with "[]" post python-ci
if grep -q "examples-suite-report:python-ci" "$STUB_BODIES"; then
  pass "the comment it writes carries the marker the next run looks it up by"
else
  fail "the comment it writes carries no marker, so every re-run during an outage posts another"
  sed 's/^/      /' "$STUB_BODIES"
fi
if grep -q "a body" "$STUB_BODIES"; then
  pass "the comment it writes carries the body it was given"
else
  fail "the body never reached the comment, so the marker is posted on its own"
  sed 's/^/      /' "$STUB_BODIES"
fi

rm -rf "$STUB_DIR"
rm -f "$STUB_CALLS" "$STUB_BODIES" "$STUB_COMMENTS" "$EVENT"

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
gate EXAMPLES_TOUCHED=false EXAMPLES_REPORT="$BIG_JUNIT" GITHUB_STEP_SUMMARY="/dev/null" \
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
EXPECTED_CHECKS=41
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
