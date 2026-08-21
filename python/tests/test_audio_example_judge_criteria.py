"""
Syntax-aware guard on the audio examples' judge criteria (#680, #682).

The four audio examples judge the same capability and must judge it the same
way. `javascript/examples/vitest/tests/audio-judge-criteria-parity.test.ts`
keeps the two language copies of the criteria byte-identical; this file keeps
the Python examples actually using theirs.

It reads the example sources with `ast` rather than matching text, because the
ways a sibling drifts are precisely the ones text matching misses: a second
`JudgeAgent` in the same file with an inline list, a local rebinding that
shadows the import, or an import that no longer comes from `helpers`. Every
`JudgeAgent(...)` call in the file has to be checked, not merely one of them.

Deterministic: it parses files. No API keys, no network, no model. Runs in
`python-ci`'s unit step alongside the rest of `tests/`, unlike the live
examples it guards.
"""

import ast
from pathlib import Path

import pytest

CRITERIA_NAME = "AUDIO_JUDGE_CRITERIA"
HELPERS_MODULE = "helpers"

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"
AUDIO_EXAMPLES = ["test_audio_to_text.py", "test_audio_to_audio.py"]


def parse(example: str) -> ast.Module:
    path = EXAMPLES / example
    assert path.is_file(), f"{path} does not exist. Did the example move?"
    return ast.parse(path.read_text(), filename=str(path))


def judge_agent_calls(tree: ast.Module) -> list[ast.Call]:
    """Every `JudgeAgent(...)` call, however the name was reached."""
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and _callee_name(node.func) == "JudgeAgent"
    ]


def _callee_name(func: ast.expr) -> str | None:
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def criteria_argument(call: ast.Call) -> ast.expr | None:
    for keyword in call.keywords:
        if keyword.arg == "criteria":
            return keyword.value
    return None


def resolves_to_shared_constant(value: ast.expr) -> bool:
    """
    True for `AUDIO_JUDGE_CRITERIA` and for the `list(...)` copy of it, which
    is the form both examples use so the judge cannot mutate the shared list.
    """
    if isinstance(value, ast.Name):
        return value.id == CRITERIA_NAME
    if (
        isinstance(value, ast.Call)
        and _callee_name(value.func) == "list"
        and len(value.args) == 1
    ):
        return resolves_to_shared_constant(value.args[0])
    return False


@pytest.mark.parametrize("example", AUDIO_EXAMPLES)
def test_imports_the_criteria_from_helpers(example: str) -> None:
    tree = parse(example)
    imported_from = {
        node.module
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
        and any(alias.name == CRITERIA_NAME for alias in node.names)
    }
    assert imported_from == {HELPERS_MODULE}, (
        f"{example} must import {CRITERIA_NAME} from `{HELPERS_MODULE}`, and from "
        f"nowhere else. Found: {imported_from or 'no import at all'}"
    )


@pytest.mark.parametrize("example", AUDIO_EXAMPLES)
def test_imports_the_criteria_under_its_own_name(example: str) -> None:
    tree = parse(example)
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == CRITERIA_NAME:
                    assert alias.asname is None, (
                        f"{example} imports {CRITERIA_NAME} as `{alias.asname}`. The "
                        "checks below track the name, so aliasing it hides drift."
                    )


@pytest.mark.parametrize("example", AUDIO_EXAMPLES)
def test_never_rebinds_the_criteria_name(example: str) -> None:
    """
    A local `AUDIO_JUDGE_CRITERIA = [...]` shadows the import, and every check
    that follows would then be reading a local list. Annotated and augmented
    assignments count: `AUDIO_JUDGE_CRITERIA: list[str] = [...]` shadows just
    as well as the plain form.
    """
    tree = parse(example)
    for node in ast.walk(tree):
        targets: list[ast.expr] = []
        if isinstance(node, ast.Assign):
            targets = list(node.targets)
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
            targets = [node.target]
        for target in targets:
            assert not (
                isinstance(target, ast.Name) and target.id == CRITERIA_NAME
            ), (
                f"{example} rebinds {CRITERIA_NAME} locally, shadowing the shared "
                "constant. Import it and leave it alone."
            )


@pytest.mark.parametrize("example", AUDIO_EXAMPLES)
def test_every_judge_uses_the_shared_criteria(example: str) -> None:
    """
    Every `JudgeAgent` in the file, not just the first one found. A file that
    passes the constant to one judge and an inline list to another is exactly
    the drift #682 was filed for.
    """
    tree = parse(example)
    calls = judge_agent_calls(tree)
    assert calls, (
        f"{example} constructs no JudgeAgent. If the example changed shape, update "
        "this guard rather than deleting it, or it passes by finding nothing."
    )

    for index, call in enumerate(calls):
        value = criteria_argument(call)
        assert value is not None, (
            f"{example}: JudgeAgent #{index + 1} (line {call.lineno}) passes no "
            "`criteria`. It must judge against the shared constant."
        )
        assert resolves_to_shared_constant(value), (
            f"{example}: JudgeAgent #{index + 1} (line {call.lineno}) is given "
            f"{ast.dump(value)[:120]} rather than {CRITERIA_NAME}. Import the shared "
            "constant instead of writing criteria inline."
        )
