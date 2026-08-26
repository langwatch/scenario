#!/usr/bin/env bash
# Run the examples suite, and tell a shared-budget outage apart from a broken
# example.
#
# THE PROBLEM. The examples suite makes real model calls through the LangWatch
# AI Gateway on one virtual key with a daily spend budget. When that budget is
# exhausted the gateway answers HTTP 402 `budget_exceeded` and every test in
# the suite fails at once. The suite feeds a required check, so an unrelated
# pull request whose own tests all pass is blocked from merging by a shared
# resource it never touched. Observed on #889, whose 1088 JavaScript and 1219
# Python tests passed while 26 example files failed on 402.
#
# WHAT THIS DOES NOT DO. It does not turn the suite green and walk away. A
# suite that cannot fail is the failure mode this repository has already been
# bitten by: #893 records fork pull requests reaching a green required check
# with nothing having run against the changed file. So the budget case is
# reported loudly, in the log and in the run summary, and it is tolerated only
# where tolerating it costs no coverage.
#
# THE RULE. A budget outage means the suite could not be run at all, not that
# it ran and disagreed:
#
#   * the suite passed                          -> pass
#   * ANY failure that is not a budget refusal  -> FAIL, this is a real defect
#   * every failure is a budget refusal, and
#     the PR changes the examples               -> FAIL, the change is
#                                                  unverified and saying
#                                                  otherwise would be a lie
#   * every failure is a budget refusal, and
#     the PR changes nothing the suite covers   -> warn and pass, the suite
#                                                  was never evidence about
#                                                  this PR
#
# The third case is the one that keeps this honest. Budget exhaustion lasts
# until the daily window resets, so without it an examples change could merge
# on a day-long green that ran nothing.
#
# EVERY failure, not any failure: a budget outage and a genuinely broken
# example can land in the same run. That decision is made per failed test by
# classify-examples-failures.py, which needs a report rather than a wall of
# text. Without one this gate does NOT fall back to leniency: it cannot verify
# the claim, so it declines to make it and the suite's own exit status stands.
#
# Required environment:
#   EXAMPLES_TOUCHED   "true" when this PR changes files the suite covers
#   EXAMPLES_REPORT    path to the JUnit XML the suite writes
# Optional:
#   GITHUB_STEP_SUMMARY  written to when set, so the reason survives the log
#
# Usage: examples-suite-gate.sh <command> [args...]
set -uo pipefail

: "${EXAMPLES_TOUCHED:?}" "${EXAMPLES_REPORT:?}"

# Anything that is not exactly true or false is a wiring bug, and the lenient
# branch is the one it would land on. `examples` reaches here from a path
# filter through `needs.changes.outputs.examples`, and the action that produces
# it documents how easily that goes wrong: a key consumed but not declared as
# an output arrives as the empty string. `:?` above catches empty; this catches
# `tru`, `True`, and `yes`, each of which would otherwise read as "the PR
# changes nothing the suite covers" and tolerate an outage that hides an
# unverified example change.
case "$EXAMPLES_TOUCHED" in
  true | false) ;;
  *)
    echo "::error::EXAMPLES_TOUCHED must be exactly 'true' or 'false', got '${EXAMPLES_TOUCHED}'. Refusing to guess which way a mis-wired value should be read."
    exit 2
    ;;
esac

if [[ $# -eq 0 ]]; then
  echo "usage: examples-suite-gate.sh <command> [args...]" >&2
  exit 2
fi

output="$(mktemp)"
trap 'rm -f "$output"' EXIT

"$@" 2>&1 | tee "$output"
status="${PIPESTATUS[0]}"

if [[ "$status" -eq 0 ]]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
verdict="$(python3 "$SCRIPT_DIR/classify-examples-failures.py" "$EXAMPLES_REPORT")"

case "$verdict" in
  "budget "*) ;;
  "mixed "*)
    echo "::error::The examples suite has failures that are not gateway budget refusals: ${verdict#mixed }. A budget outage does not excuse them."
    exit "$status"
    ;;
  nofailures)
    echo "::error::The examples suite exited ${status} but its report lists no failed test, so nothing here can be attributed to the budget."
    exit "$status"
    ;;
  *)
    echo "::error::Could not read the examples report at ${EXAMPLES_REPORT} (${verdict}), so the budget claim cannot be checked. Treating this as a real failure."
    exit "$status"
    ;;
esac

note="The examples suite could not run: the shared gateway virtual key is over its daily budget (HTTP 402 budget_exceeded). This is an infrastructure limit on a key shared by every pull request, not a result about any one of them."

if [[ "$EXAMPLES_TOUCHED" == "true" ]]; then
  echo "::error::${note} This pull request changes files the suite covers, so the change is unverified and the check stays red. Re-run once the daily window resets."
  {
    echo "### Examples suite: budget exhausted, and this PR changes examples"
    echo ""
    echo "${note}"
    echo ""
    echo "The check stays red because nothing verified the changed example. Re-run after the daily budget window resets."
  } >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit "$status"
fi

echo "::warning::${note} This pull request changes nothing the suite covers, so it is not held on that. The suite still did NOT run."
{
  echo "### Examples suite: not run (gateway budget exhausted)"
  echo ""
  echo "${note}"
  echo ""
  echo "This pull request changes nothing the suite covers, so it is not held on the outage. Treat the examples as unverified for this run, not as passing."
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
exit 0
