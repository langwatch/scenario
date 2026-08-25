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
#   * failed, no budget signal                  -> FAIL, this is a real defect
#   * failed on budget, PR changes the examples -> FAIL, the change is
#                                                  unverified and saying
#                                                  otherwise would be a lie
#   * failed on budget, PR changes nothing the
#     suite covers                              -> warn and pass, the suite
#                                                  was never evidence about
#                                                  this PR
#
# The third case is the one that keeps this honest. Budget exhaustion lasts
# until the daily window resets, so without it an examples change could merge
# on a day-long green that ran nothing.
#
# Required environment:
#   EXAMPLES_TOUCHED   "true" when this PR changes files the suite covers
# Optional:
#   GITHUB_STEP_SUMMARY  written to when set, so the reason survives the log
#
# Usage: examples-suite-gate.sh <command> [args...]
set -uo pipefail

: "${EXAMPLES_TOUCHED:?}"

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

# The gateway's own wording for a hard budget breach. `budget_scope` appears in
# `error.meta` on the same response, so either is proof the refusal came from
# the budget rather than from the example.
if ! grep -qiE 'budget_exceeded|budget_scope' "$output"; then
  echo "::error::The examples suite failed and nothing in its output names the gateway budget, so this is a real failure."
  exit "$status"
fi

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
