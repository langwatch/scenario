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
  # Membership of the `relevant` list the detect-changes step actually
  # declares, not a substring of the file. An unscoped grep passed on any line
  # that happened to contain the needle: `docs/` is satisfied by the sibling
  # entry '.github/workflows/docs-ci.yml' AND by the build job's
  # cache-dependency-path, so deleting the real filter left this check saying
  # PASS. python-ci escaped only because `python/**` happens to appear nowhere
  # else in its file, which is luck rather than a check. This parses the YAML
  # the way every other check in this script already does.
  if python3 - "$wf" "$filter1" "$filter2" <<'EOF'
import yaml, sys
with open(sys.argv[1]) as f:
    d = yaml.safe_load(f)
wanted = sys.argv[2:]
changes = d.get('jobs', {}).get('changes', {})
declared = None
for step in changes.get('steps', []) or []:
    # Exact reference, not a substring: any action whose name merely contains
    # "detect-changes" could supply a matching `filters` input and satisfy this
    # while the job never uses the local one. That is the same shape of hole
    # this check was written to close, one level up.
    if step.get('uses') == './.github/actions/detect-changes':
        declared = (step.get('with') or {}).get('filters')
        break
if declared is None:
    print("changes job declares no detect-changes step with filters")
    sys.exit(1)
# `filters` is a block scalar carrying its own YAML document.
patterns = (yaml.safe_load(declared) or {}).get('relevant')
if not isinstance(patterns, list):
    print(f"the relevant filter is not a list: {patterns!r}")
    sys.exit(1)
missing = [w for w in wanted if w not in patterns]
if missing:
    print(f"missing from the relevant filter: {missing}; declared: {patterns}")
    sys.exit(1)
EOF
  then pass "$name: path filters ($filter1, $filter2) present"; else fail "$name: path filters missing (expected $filter1 and $filter2)"; fi

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
  "python/**" \
  ".github/workflows/python-ci.yml"

check_workflow \
  "$REPO_ROOT/.github/workflows/javascript-ci.yml" \
  "javascript-ci" \
  "ci-checks" \
  "javascript-complete" \
  "javascript/**" \
  ".github/workflows/javascript-ci.yml"

check_workflow \
  "$REPO_ROOT/.github/workflows/docs-ci.yml" \
  "docs-ci" \
  "build" \
  "docs-complete" \
  "docs/**" \
  ".github/workflows/docs-ci.yml"

# ---------------------------------------------------------------------------
# Examples coverage on runs without secrets (see #893)
#
# The examples suite needs repo secrets, so it cannot run on a fork PR or a
# Dependabot PR. Skipping it there is right; leaving nothing in its place is
# not, because the aggregator counts a skipped step's job as success and an
# examples-only change from an external contributor then reaches a green
# required check with nothing having read the file it changed.
#
# The invariant is that exactly one of the two examples steps runs on any
# given run: the live suite when secrets are readable, the secret-free
# collection when they are not. Both must therefore be gated on the same
# resolver output, with opposite senses. Complementary conditions written out
# by hand in two places drift; this is what notices when they do.
# ---------------------------------------------------------------------------
echo ""
echo "=== Validating examples coverage without secrets ==="
if python3 - "$REPO_ROOT/.github/workflows/python-ci.yml" <<'EOF'
import yaml, sys

with open(sys.argv[1]) as f:
    workflow = yaml.safe_load(f)

steps = workflow.get("jobs", {}).get("test", {}).get("steps", [])
if not steps:
    print("python-ci: test job has no steps")
    sys.exit(1)

resolver = [s for s in steps if s.get("id") == "secrets"]
if len(resolver) != 1:
    print(f"expected exactly one step with id: secrets, found {len(resolver)}")
    sys.exit(1)
# Both senses, and written where a later step can read them. A resolver that
# sets some other name, or echoes the right name without the redirect, leaves
# `steps.secrets.outputs.available` empty: the live suite's `== 'true'` is then
# never true and the collection's `!= 'true'` always is, so the examples suite
# silently stops running everywhere while this validator reports PASS.
resolver_run = resolver[0].get("run", "")
for value in ("true", "false"):
    if not any(
        f"available={value}" in line and "$GITHUB_OUTPUT" in line
        for line in resolver_run.splitlines()
    ):
        print(f"the resolver never writes available={value} to $GITHUB_OUTPUT")
        sys.exit(1)

GATE = "steps.secrets.outputs.available"
examples = [s for s in steps if "examples/" in s.get("run", "")]
if len(examples) != 2:
    print(f"expected two steps running examples/, found {len(examples)}")
    sys.exit(1)

with_secrets = [s for s in examples if s.get("if", "") == f"{GATE} == 'true'"]
without_secrets = [s for s in examples if s.get("if", "") == f"{GATE} != 'true'"]
if len(with_secrets) != 1 or len(without_secrets) != 1:
    print("the two examples steps are not complementary on " + GATE)
    for s in examples:
        print(f"  {s.get('name', '<unnamed>')!r}: if: {s.get('if', '<none>')!r}")
    sys.exit(1)

# Which step does what, not just that two exist. The failure worth catching is
# the live suite quietly becoming a second collection: both steps would still
# be present and complementary, and nothing would run the examples again.
live_run = with_secrets[0].get("run", "")
collect_run = without_secrets[0].get("run", "")
if "pytest examples/" not in live_run or "--collect-only" in live_run:
    print("the secret-enabled step does not run the live suite: " + live_run)
    sys.exit(1)
if "pytest examples/" not in collect_run or "--collect-only" not in collect_run:
    print("the secret-free step does not collect: " + collect_run)
    sys.exit(1)
EOF
then pass "python-ci: examples are covered on runs without secrets"
else fail "python-ci: examples are not covered on runs without secrets"; fi

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
