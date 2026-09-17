"""Classify every failed test in a JUnit report as a gateway budget refusal or not.

Prints one word plus detail, for the shell gate to branch on:

    budget <n>     every failed test was refused on the gateway budget
    mixed <names>  at least one failure was NOT a budget refusal
    nofailures     the report lists no failed test at all
    unreadable <e> the report could not be read

EVERY failure, not any failure. A budget outage and a genuinely broken example
can land in the same run: the tests that reach the gateway get 402 while one
that fails on its own assertion fails for its own reason. Deciding on "the
output mentions the budget somewhere" would hide that real failure, which is
why this reads a report rather than the log. Grepping cannot do it across both
suites either, since pytest puts the reason on its summary line and vitest does
not.
"""

import re
import sys
import xml.etree.ElementTree as ET

BUDGET_MARKERS = ("budget_exceeded", "budget_scope")

# A JUnit report from pytest or vitest is kilobytes. Anything past this is not
# one, and reading it would be the denial of service rather than the defence.
MAX_REPORT_BYTES = 16 * 1024 * 1024

DOCTYPE = re.compile(r"<!DOCTYPE", re.IGNORECASE)


def classify(path: str) -> str:
    """Read the report defensively, then decide.

    `xml.etree` resolves no external entities, but it does expand internal
    ones, so a report carrying a `<!DOCTYPE>` with nested entity definitions
    can be made to expand to gigabytes. Neither pytest nor vitest ever writes a
    doctype into a JUnit report, so refusing one closes that off entirely and
    costs nothing. That is preferred here over `defusedxml`: this script runs
    under the runner's bare `python3` rather than under `uv`, so a third-party
    import would not resolve at all.

    The threat is modest either way: whoever can write this file already runs
    the test suite on this runner. This is depth rather than the only barrier,
    and refusing is fail-closed, since the gate reads `unreadable` and keeps
    the suite's own red exit status.
    """
    try:
        with open(path, "rb") as handle:
            raw = handle.read(MAX_REPORT_BYTES + 1)
    except OSError as error:
        return f"unreadable {error}"

    if len(raw) > MAX_REPORT_BYTES:
        return f"unreadable report is larger than {MAX_REPORT_BYTES} bytes"

    report_text = raw.decode("utf-8", errors="replace")
    if DOCTYPE.search(report_text):
        return "unreadable report carries a doctype, which no test runner writes"

    try:
        root = ET.fromstring(report_text)
    except ET.ParseError as error:
        return f"unreadable {error}"

    budget = 0
    other: list[str] = []
    for case in root.iter("testcase"):
        problems = list(case.findall("failure")) + list(case.findall("error"))
        if not problems:
            continue
        text = " ".join(
            f"{p.get('message') or ''} {p.text or ''}" for p in problems
        ).lower()
        if any(marker in text for marker in BUDGET_MARKERS):
            budget += 1
        else:
            name = f"{case.get('classname') or ''}::{case.get('name') or '?'}"
            other.append(name.strip(":"))

    if other:
        return "mixed " + "; ".join(other[:5])
    if budget:
        return f"budget {budget}"
    return "nofailures"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: classify-examples-failures.py <junit.xml>", file=sys.stderr)
        raise SystemExit(2)
    print(classify(sys.argv[1]))
