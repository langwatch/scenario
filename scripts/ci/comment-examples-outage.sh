#!/usr/bin/env bash
# Say on the pull request what the examples suite actually did.
#
# WHY THIS EXISTS. The gate already emits `::warning::` and writes
# `$GITHUB_STEP_SUMMARY`. Both live in the Actions UI, behind a click, on a
# check that is GREEN. A reviewer reading the pull request sees a passing
# required check and has no reason to look further, and what happened is that
# the suite never ran at all. The whole point of tolerating a budget outage is
# that it costs no coverage; that argument only holds while the reader knows
# coverage was not collected.
#
# THIS NEVER FAILS THE BUILD. The gate decides its verdict before calling this,
# and that verdict must not depend on whether a comment could be posted. No
# token, a read-only token, an API blip, a payload without a pull request: all
# of them log a line and exit 0. Reporting is not the gate.
#
# ONE COMMENT PER SUITE, EDITED IN PLACE. Keyed on a hidden marker carrying the
# workflow name, so javascript-ci and python-ci keep separate comments and a
# re-run edits rather than appends. The marker is derived from GITHUB_WORKFLOW
# rather than passed in as another environment key: the trap #944 documented is
# that every key a workflow has to wire is a key it can wire wrong, arriving as
# an empty string that looks wired and answers nothing. This needs no wiring.
#
# Usage: comment-examples-outage.sh <post|update-only>   with the body on stdin
#
#   post         create the comment, or edit the existing one
#   update-only  edit an existing comment, and create nothing if there is none
#
# `update-only` is what the success path uses: a run that passes should replace
# a stale "the suite did not run" left by an earlier attempt, but must never be
# the thing that introduces a comment about an outage that is over.
set -uo pipefail

mode="${1:-}"
case "$mode" in
  post | update-only) ;;
  *)
    echo "usage: comment-examples-outage.sh <post|update-only>  (body on stdin)" >&2
    exit 0
    ;;
esac

body="$(cat)"

# Every exit from here is 0. The name says what was skipped and why, because a
# comment that silently never appears is the failure this script exists to
# prevent, one level up.
skip() {
  echo "note: examples-suite comment not posted (${1})."
  exit 0
}

[[ -n "$body" ]] || skip "empty body"
[[ -n "${GITHUB_REPOSITORY:-}" ]] || skip "no GITHUB_REPOSITORY, so this is not a workflow run"

token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
[[ -n "$token" ]] || skip "no GITHUB_TOKEN or GH_TOKEN in the environment"

# The pull request number comes from the event payload rather than from an
# input, for the same reason the marker does.
pr=""
if [[ -n "${GITHUB_EVENT_PATH:-}" && -r "${GITHUB_EVENT_PATH}" ]]; then
  pr="$(python3 - "$GITHUB_EVENT_PATH" <<'PY' 2>/dev/null || true
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        event = json.load(handle)
except (OSError, ValueError):
    raise SystemExit(0)

number = (event.get("pull_request") or {}).get("number")
if isinstance(number, int):
    print(number)
PY
)"
fi
[[ -n "$pr" ]] || skip "the event payload carries no pull request, so there is nothing to comment on"

marker="<!-- examples-suite-report:${GITHUB_WORKFLOW:-unknown} -->"

payload="$(mktemp)"
listing="$(mktemp)"
trap 'rm -f "$payload" "$listing"' EXIT
printf '%s\n\n%s\n' "$marker" "$body" >"$payload"

export GH_TOKEN="$token"

if ! gh api "repos/${GITHUB_REPOSITORY}/issues/${pr}/comments?per_page=100" --paginate >"$listing" 2>/dev/null; then
  skip "could not read the existing comments on #${pr}"
fi

# Matched in Python rather than with a jq filter built by string interpolation:
# the marker contains the characters that would need escaping into one, and a
# quoting bug here reads as "no existing comment" and posts a duplicate on
# every re-run.
existing="$(python3 - "$listing" "$marker" <<'PY' 2>/dev/null || true
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        comments = json.load(handle)
except (OSError, ValueError):
    raise SystemExit(0)

if not isinstance(comments, list):
    raise SystemExit(0)

marker = sys.argv[2]
matching = [
    comment["id"]
    for comment in comments
    if isinstance(comment, dict)
    and isinstance(comment.get("body"), str)
    and marker in comment["body"]
    and isinstance(comment.get("id"), int)
]
if matching:
    print(matching[-1])
PY
)"

if [[ -n "$existing" ]]; then
  if gh api "repos/${GITHUB_REPOSITORY}/issues/comments/${existing}" -X PATCH -F body=@"$payload" >/dev/null 2>&1; then
    echo "note: updated the examples-suite comment on #${pr}."
    exit 0
  fi
  skip "could not update comment ${existing} on #${pr}"
fi

[[ "$mode" == "post" ]] || skip "nothing to update on #${pr}, and update-only was asked for"

if gh api "repos/${GITHUB_REPOSITORY}/issues/${pr}/comments" -F body=@"$payload" >/dev/null 2>&1; then
  echo "note: posted the examples-suite comment on #${pr}."
  exit 0
fi
skip "could not post a comment on #${pr}; the token is probably read-only"
