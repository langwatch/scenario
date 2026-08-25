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

import sys
import xml.etree.ElementTree as ET

BUDGET_MARKERS = ("budget_exceeded", "budget_scope")


def classify(path: str) -> str:
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as error:
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
