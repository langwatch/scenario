#!/usr/bin/env bash
# Validates aggregator-pattern workflow shape for python-ci, javascript-ci,
# and docs-ci. See #364. Exit codes: 0 = all pass, 1 = one or more failures.
set -euo pipefail
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=1; }

# check_workflow <file> <name> <inner_job> <aggregator> <filter1> <filter2>
check_workflow() {
  local wf="$1"
  local name="$2"
  local inner_job="$3"
  local aggregator="$4"
  local filter1="$5"
  local filter2="$6"

  echo ""
  echo "=== Validating $wf ==="

  if [ ! -f "$wf" ]; then
    fail "$name: file not found at $wf"
    return
  fi

  echo "--- No top-level paths: filter ---"
  if python3 - "$wf" <<'EOF'
import yaml, sys
with open(sys.argv[1]) as f:
    d = yaml.safe_load(f)
on = d.get('on', d.get(True, {}))
if isinstance(on, dict):
    pr = on.get('pull_request', {})
    push = on.get('push', {})
    if isinstance(pr, dict) and 'paths' in pr:
        print("pull_request has paths filter")
        sys.exit(1)
    if isinstance(push, dict) and 'paths' in push:
        print("push has paths filter")
        sys.exit(1)
EOF
  then pass "$name: no top-level paths: filter"; else fail "$name: top-level paths: filter found"; fi

  echo "--- changes job exists with relevant output ---"
  if python3 - "$wf" <<'EOF'
import yaml, sys
with open(sys.argv[1]) as f:
    d = yaml.safe_load(f)
jobs = d.get('jobs', {})
changes = jobs.get('changes', {})
if not changes:
    print("changes job missing")
    sys.exit(1)
outputs = changes.get('outputs', {})
if 'relevant' not in outputs:
    print("changes job missing relevant output")
    sys.exit(1)
EOF
  then pass "$name: changes job with relevant output"; else fail "$name: changes job or relevant output missing"; fi

  echo "--- $aggregator job with if: always() ---"
  if python3 - "$wf" "$aggregator" <<'EOF'
import yaml, sys
with open(sys.argv[1]) as f:
    d = yaml.safe_load(f)
agg = sys.argv[2]
jobs = d.get('jobs', {})
job = jobs.get(agg, {})
if not job:
    print(f"{agg} job missing")
    sys.exit(1)
cond = job.get('if', '')
if str(cond).strip() != 'always()':
    print(f"if condition is {repr(cond)}, expected always()")
    sys.exit(1)
EOF
  then pass "$name: $aggregator job with if: always()"; else fail "$name: $aggregator job or if: always() missing"; fi

  echo "--- inline jq gate present ---"
  if grep -q 'jq -e' "$wf"; then
    pass "$name: inline jq gate present"
  else
    fail "$name: inline jq gate missing"
  fi

  echo "--- concurrency group keying ---"
  EXPECTED_CONCURRENCY='${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}'
  if grep -qF "$EXPECTED_CONCURRENCY" "$wf"; then
    pass "$name: concurrency group keyed on event_name + PR number or ref"
  else
    fail "$name: concurrency group does not match expected: $EXPECTED_CONCURRENCY"
  fi

  echo "--- cancel-in-progress: true ---"
  if python3 - "$wf" <<'EOF'
import yaml, sys
with open(sys.argv[1]) as f:
    d = yaml.safe_load(f)
conc = d.get('concurrency', {})
if conc.get('cancel-in-progress') is not True:
    print("cancel-in-progress not true")
    sys.exit(1)
EOF
  then pass "$name: cancel-in-progress: true"; else fail "$name: cancel-in-progress not set to true"; fi

  echo "--- path filters in changes job ---"
  if grep -q "$filter1" "$wf" && grep -q "$filter2" "$wf"; then
    pass "$name: path filters ($filter1, $filter2) present"
  else
    fail "$name: path filters missing (expected $filter1 and $filter2)"
  fi

  echo "--- $inner_job needs changes ---"
  if python3 - "$wf" "$inner_job" <<'EOF'
import yaml, sys
with open(sys.argv[1]) as f:
    d = yaml.safe_load(f)
job_name = sys.argv[2]
jobs = d.get('jobs', {})
job = jobs.get(job_name, {})
needs = job.get('needs', [])
if isinstance(needs, str):
    needs = [needs]
if 'changes' not in needs:
    print(f"{job_name}.needs does not include changes: {needs}")
    sys.exit(1)
EOF
  then pass "$name: $inner_job needs changes"; else fail "$name: $inner_job does not need changes"; fi
}

echo ""
echo "=== Validating detect-changes composite action ==="
ACTION="$REPO_ROOT/.github/actions/detect-changes/action.yml"
if [ -f "$ACTION" ]; then
  pass "detect-changes action.yml exists"
else
  fail "detect-changes action.yml missing at $ACTION"
fi

if [ -f "$ACTION" ]; then
  if python3 - "$ACTION" <<'EOF'
import yaml, sys
with open(sys.argv[1]) as f:
    d = yaml.safe_load(f)
outputs = d.get('outputs', {})
if 'relevant' not in outputs:
    print("relevant output missing")
    sys.exit(1)
for bad in ('feature-parity', 'lambda-image'):
    if bad in outputs:
        print(f"unexpected output declared: {bad}")
        sys.exit(1)
EOF
  then pass "detect-changes: only relevant output declared"; else fail "detect-changes: wrong outputs"; fi

  DORNY_SHA="fbd0ab8f3e69293af611ebaee6363fc25e6d187d"
  if grep -q "dorny/paths-filter@$DORNY_SHA" "$ACTION"; then
    pass "detect-changes: dorny/paths-filter pinned to correct SHA"
  else
    fail "detect-changes: dorny/paths-filter SHA mismatch (expected $DORNY_SHA)"
  fi
fi

check_workflow \
  "$REPO_ROOT/.github/workflows/python-ci.yml" \
  "python-ci" \
  "test" \
  "python-complete" \
  "python/" \
  "python-ci.yml"

check_workflow \
  "$REPO_ROOT/.github/workflows/javascript-ci.yml" \
  "javascript-ci" \
  "ci-checks" \
  "javascript-complete" \
  "javascript/" \
  "javascript-ci.yml"

check_workflow \
  "$REPO_ROOT/.github/workflows/docs-ci.yml" \
  "docs-ci" \
  "build" \
  "docs-complete" \
  "docs/" \
  "docs-ci.yml"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== ALL CHECKS PASSED ==="
else
  echo "=== SOME CHECKS FAILED ==="
  exit 1
fi
