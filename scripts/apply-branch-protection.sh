#!/usr/bin/env bash
# =============================================================================
# apply-branch-protection.sh
#
# What it does:
#   Applies the PR-gate branch protection configuration to `main`. Swaps the
#   legacy `check-approval-or-label` required status check for the new
#   aggregator checks (`python-complete`, `javascript-complete`) and raises the
#   required approving reviewer count from 0 to 1. Also registers
#   `drewdrewthis` as a bypass user alongside the pre-existing `rogeriochaves`.
#
# Idempotent:
#   Safe to re-run. The GitHub branch-protection PUT is a full replacement, so
#   running this script twice produces the same end state as running it once.
#
# IMPORTANT: DO NOT run by hand without reading the GitHub API response
#   carefully. This modifies branch protection on `main` in production.
#   Verify the printed post-apply state matches expectations before merging
#   any downstream PRs that depend on the new required checks.
#
# Run from the repo root:
#   bash scripts/apply-branch-protection.sh
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Detect the repository (owner/name) dynamically so this script is portable
# across forks and renames.
# ---------------------------------------------------------------------------
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
echo "Target repository: $REPO"
echo "Target branch: main"
echo ""

# ---------------------------------------------------------------------------
# Apply branch protection via a full PUT (partial PATCHes lose unspecified
# fields; GitHub's branch-protection API requires a complete payload).
#
# Fields and their rationale:
#   required_status_checks.strict         — require branch to be up-to-date
#   required_status_checks.contexts       — new aggregator checks
#   required_approving_review_count       — raised 0 → 1
#   dismiss_stale_reviews                 — unchanged from current state
#   require_code_owner_reviews            — false (not currently set)
#   bypass_pull_request_allowances.users  — rogeriochaves + drewdrewthis
#   enforce_admins                        — false (unchanged)
#   restrictions                          — null (no push restrictions currently)
#   allow_force_pushes                    — true (unchanged; out of scope)
#   allow_deletions                       — false (unchanged)
#   required_signatures                   — false (unchanged)
# ---------------------------------------------------------------------------
echo "Applying branch protection to $REPO/main …"

gh api -X PUT "repos/$REPO/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["python-complete", "javascript-complete"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "bypass_pull_request_allowances": {
      "users": ["rogeriochaves", "drewdrewthis"],
      "teams": [],
      "apps": []
    }
  },
  "restrictions": null,
  "allow_force_pushes": true,
  "allow_deletions": false,
  "required_signatures": false
}
JSON

echo ""
echo "Branch protection applied. Fetching post-apply state for verification …"
echo ""

# ---------------------------------------------------------------------------
# Fetch and pretty-print the new state.
# ---------------------------------------------------------------------------
STATE=$(gh api "repos/$REPO/branches/main/protection" --jq '{
  required_status_checks: .required_status_checks.contexts,
  review_count: .required_pull_request_reviews.required_approving_review_count,
  dismiss_stale: .required_pull_request_reviews.dismiss_stale_reviews,
  bypass_users: [.required_pull_request_reviews.bypass_pull_request_allowances.users[].login],
  enforce_admins: .enforce_admins.enabled
}')

echo "Post-apply state:"
echo "$STATE" | jq .

# ---------------------------------------------------------------------------
# Validate post-apply state.
# ---------------------------------------------------------------------------
echo ""
echo "Validating …"

ERRORS=0

# required_status_checks must be exactly ["python-complete","javascript-complete"]
CONTEXTS=$(echo "$STATE" | jq -r '.required_status_checks | join(",")')
if [ "$CONTEXTS" != "python-complete,javascript-complete" ]; then
  echo "FAIL: required_status_checks contexts are '$CONTEXTS'" \
       "(expected: python-complete,javascript-complete)"
  ERRORS=$((ERRORS + 1))
else
  echo "  PASS: required_status_checks = [python-complete, javascript-complete]"
fi

# review_count must be 1
REVIEW_COUNT=$(echo "$STATE" | jq -r '.review_count')
if [ "$REVIEW_COUNT" != "1" ]; then
  echo "FAIL: required_approving_review_count is $REVIEW_COUNT (expected 1)"
  ERRORS=$((ERRORS + 1))
else
  echo "  PASS: required_approving_review_count = 1"
fi

# bypass_users must include both rogeriochaves and drewdrewthis
HAS_ROGERIOCHAVES=$(echo "$STATE" | jq -r '.bypass_users | index("rogeriochaves") != null')
HAS_DREW=$(echo "$STATE" | jq -r '.bypass_users | index("drewdrewthis") != null')

if [ "$HAS_ROGERIOCHAVES" != "true" ]; then
  echo "FAIL: bypass_users is missing rogeriochaves"
  ERRORS=$((ERRORS + 1))
else
  echo "  PASS: bypass_users includes rogeriochaves"
fi

if [ "$HAS_DREW" != "true" ]; then
  echo "FAIL: bypass_users is missing drewdrewthis"
  ERRORS=$((ERRORS + 1))
else
  echo "  PASS: bypass_users includes drewdrewthis"
fi

echo ""

if [ "$ERRORS" -ne 0 ]; then
  echo "ERROR: $ERRORS validation check(s) failed. Review the API response above and re-apply if needed."
  exit 1
fi

# ---------------------------------------------------------------------------
# All checks passed.
# ---------------------------------------------------------------------------
printf '\033[0;32m================================================\n'
printf 'SUCCESS — branch protection applied and verified.\n'
printf '================================================\033[0m\n'
