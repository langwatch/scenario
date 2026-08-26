#!/usr/bin/env bash
# Validates the wiring around the examples suite: that its budget gate is
# actually in front of it, and that every path filter a workflow consumes is
# one the composite action really exposes.
#
# The second is a trap the action documents and nothing enforced. From
# .github/actions/detect-changes/action.yml:
#
#   "every filter key the caller wants to consume must be declared as an
#    outputs.<key> entry below AND echoed into the force step ... silently
#    missing entries land as empty strings."
#
# An empty string is the worst possible value here: `false` and `true` are both
# decisions, empty is a filter that looks wired and answers nothing. This turns
# that comment into a check.
#
# Exit codes: 0 = all pass, 1 = one or more failures.
set -uo pipefail
FAIL=0
CHECKS=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

pass() { echo "  PASS: $1"; CHECKS=$((CHECKS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=1; CHECKS=$((CHECKS + 1)); }

echo "=== Every consumed filter key is exposed by detect-changes ==="
while IFS='|' read -r wf key kind; do
  [ -z "$wf" ] && continue
  case "$kind" in
    ok) pass "$wf consumes '$key', which the action declares and forces" ;;
    undeclared) fail "$wf consumes '$key' but action.yml has no outputs.$key, so it is always the empty string" ;;
    unforced) fail "$wf consumes '$key' but the force step never sets it, so it is empty on push/dispatch" ;;
  esac
done < <(python3 - "$REPO_ROOT" <<'PY'
import re, sys, pathlib, yaml

root = pathlib.Path(sys.argv[1])
action_path = root / ".github/actions/detect-changes/action.yml"
action = yaml.safe_load(action_path.read_text())
declared = set(action.get("outputs", {}))
forced = set(
    re.findall(r'echo "([A-Za-z0-9_-]+)=', action_path.read_text())
)

for wf in sorted((root / ".github/workflows").glob("*.yml")):
    text = wf.read_text()
    if "detect-changes" not in text:
        continue
    for key in sorted(set(re.findall(r"steps\.detect\.outputs\.([A-Za-z0-9_-]+)", text))):
        if key not in declared:
            print(f"{wf.name}|{key}|undeclared")
        elif key not in forced:
            print(f"{wf.name}|{key}|unforced")
        else:
            print(f"{wf.name}|{key}|ok")
PY
)

echo ""
echo "=== The examples suite runs behind the budget gate ==="
GATE="scripts/ci/examples-suite-gate.sh"
if [ -x "$REPO_ROOT/$GATE" ]; then
  pass "$GATE exists and is executable"
else
  fail "$GATE is missing or not executable, so every wiring below would fail at run time"
fi

while IFS='|' read -r wf verdict detail; do
  [ -z "$wf" ] && continue
  case "$verdict" in
    ok) pass "$wf runs its examples suite through the gate, and writes the report the gate classifies" ;;
    *) fail "$wf: $detail" ;;
  esac
done < <(python3 - "$REPO_ROOT" <<'PY'
import sys, pathlib, yaml

root = pathlib.Path(sys.argv[1])
# The workflows whose required check the examples suite can block.
for name in ("python-ci.yml", "javascript-ci.yml"):
    wf = root / ".github/workflows" / name
    doc = yaml.safe_load(wf.read_text())
    steps = [s for job in doc["jobs"].values() for s in (job.get("steps") or [])]
    examples = [s for s in steps if (s.get("name") or "").startswith("Test (Examples)")]
    if not examples:
        print(f"{name}|missing|has no 'Test (Examples)' step, so this check is scanning nothing")
        continue
    for step in examples:
        run = step.get("run", "") or ""
        env = step.get("env", {}) or {}
        if "examples-suite-gate.sh" not in run:
            print(f"{name}|raw|'{step.get('name')}' runs the suite directly, so a shared-budget outage blocks every unrelated PR")
        elif "EXAMPLES_TOUCHED" not in env:
            print(f"{name}|noenv|'{step.get('name')}' calls the gate without EXAMPLES_TOUCHED, and the gate refuses to guess")
        elif "EXAMPLES_REPORT" not in env:
            print(f"{name}|noreport|'{step.get('name')}' calls the gate without EXAMPLES_REPORT, so it cannot classify failures per test")
        elif "$EXAMPLES_REPORT" not in run:
            print(f"{name}|nowrite|'{step.get('name')}' never tells the suite to write $EXAMPLES_REPORT, so the report the gate reads would never exist")
        else:
            print(f"{name}|ok|")
PY
)

echo ""
echo "=== An example change from a fork cannot pass unexamined ==="
# The examples suite needs secrets, so it is skipped for fork pull requests.
# That is #893: a fork changed an example, every step that reads examples was
# skipped, and the required check went green having read nothing. The fix is a
# secret-free fallback on the exact complementary condition, so that for any
# event precisely one of the two runs. Checking "a fallback exists" would not
# be enough: two conditions can both be false and leave the same hole.
while IFS='|' read -r wf verdict detail; do
  [ -z "$wf" ] && continue
  case "$verdict" in
    ok) pass "$wf pairs its secret-gated examples step with a secret-free fallback on the complementary condition" ;;
    *) fail "$wf: $detail" ;;
  esac
done < <(python3 - "$REPO_ROOT" <<'PYINNER'
import itertools
import pathlib
import re
import sys

import yaml

root = pathlib.Path(sys.argv[1])

TOKEN = re.compile(r"'[^']*'|[A-Za-z_][A-Za-z0-9_.\[\]-]*")


def to_python(expr):
    """Rewrite a GitHub `if:` expression as a Python one over a variables dict.

    Only the grammar these two workflows use: dotted contexts, single-quoted
    literals, == and !=, && and ||, and parentheses.
    """
    names = set()

    def swap(match):
        token = match.group(0)
        if token.startswith("'"):
            return token
        names.add(token)
        return f"V[{token!r}]"

    body = TOKEN.sub(swap, expr.replace("&&", " and ").replace("||", " or "))
    # `and` and `or` were introduced above as bare words, not as contexts.
    body = body.replace("V['and']", "and").replace("V['or']", "or")
    names.discard("and")
    names.discard("or")
    return body, names


def exactly_one_always(gated, fallback):
    """True when the two conditions partition every context we can construct."""
    gated_body, gated_names = to_python(gated)
    fallback_body, fallback_names = to_python(fallback)
    names = sorted(gated_names | fallback_names)
    # Every literal either expression compares against, plus a value that is
    # none of them, so "some other actor" and "some other event" are covered.
    literals = sorted(set(re.findall(r"'([^']*)'", gated + fallback))) + ["<other>"]
    for combo in itertools.product(literals, repeat=len(names)):
        variables = dict(zip(names, combo))
        if eval(gated_body, {}, {"V": variables}) == eval(  # noqa: S307
            fallback_body, {}, {"V": variables}
        ):
            return False, variables
    return True, None


for name in ("python-ci.yml", "javascript-ci.yml"):
    wf = root / ".github/workflows" / name
    doc = yaml.safe_load(wf.read_text())
    steps = [s for job in doc["jobs"].values() for s in (job.get("steps") or [])]
    named = {(s.get("name") or ""): s for s in steps}

    gated = next((s for n, s in named.items() if n.startswith("Test (Examples)")), None)
    if gated is None:
        print(f"{name}|missing|has no 'Test (Examples)' step, so this check is scanning nothing")
        continue
    if not gated.get("if"):
        print(f"{name}|unconditional|'Test (Examples)' has no condition, so the pairing below cannot be reasoned about")
        continue

    fallback = next(
        (s for n, s in named.items() if n.startswith(("Collect (Examples)", "List (Examples)"))),
        None,
    )
    if fallback is None:
        print(
            f"{name}|nofallback|'Test (Examples)' is skipped without secrets and nothing else reads "
            f"the examples, so a fork can change them and still go green"
        )
        continue

    # The `secrets` context specifically. `steps.secrets.outputs.available` is
    # the id of the step that decides availability, not a secret read.
    if re.search(r"\$\{\{\s*secrets\.", yaml.safe_dump(fallback)):
        print(f"{name}|needssecrets|'{fallback.get('name')}' reads secrets, so it is skipped in exactly the case it exists to cover")
        continue

    ok, witness = exactly_one_always(gated["if"], fallback.get("if") or "true")
    if ok:
        print(f"{name}|ok|")
    else:
        print(f"{name}|notcomplement|'{fallback.get('name')}' is not the complement of 'Test (Examples)': both are {witness}")
PYINNER
)

echo ""
# A validator that finds nothing to check prints the same closing line as one
# that checked everything.
EXPECTED_MIN=10
if [ "$CHECKS" -lt "$EXPECTED_MIN" ]; then
  echo "  FAIL: ran $CHECKS checks, expected at least $EXPECTED_MIN; this validator is scanning nothing"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "All $CHECKS examples-gate wiring checks passed."
else
  echo "examples-gate wiring checks FAILED."
fi
exit "$FAIL"
