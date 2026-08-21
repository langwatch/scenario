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
from typing import Final

import pytest

CRITERIA_NAME: Final = "AUDIO_JUDGE_CRITERIA"
HELPERS_MODULE: Final = "helpers"
LIST_BUILTIN: Final = "list"

EXAMPLES: Final = Path(__file__).resolve().parents[1] / "examples"
AUDIO_EXAMPLES: Final = ["test_audio_to_text.py", "test_audio_to_audio.py"]


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


def bindings(tree: ast.Module) -> list[tuple[str, ast.AST]]:
    """
    Every name this module binds, by any means, with the node that binds it.

    Collected rather than scope-resolved on purpose. The checks below want to
    say "this name is bound exactly once, by that import", and a binding that
    is invisible to this walk is the only way to break them. `ast.Name` in a
    Store or Del context covers assignment targets, `for` targets, walrus,
    `with ... as` and comprehension targets alike; `ast.arg` covers function
    and lambda parameters; `alias` covers both import forms; `ExceptHandler`
    covers `except ... as`.
    """
    found: list[tuple[str, ast.AST]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            found.append((node.id, node))
        elif isinstance(node, ast.arg):
            found.append((node.arg, node))
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                found.append((alias.asname or alias.name.split(".")[0], alias))
        elif isinstance(node, ast.ExceptHandler) and node.name:
            found.append((node.name, node))
    return found


@pytest.mark.parametrize("example", AUDIO_EXAMPLES)
def test_binds_the_criteria_name_only_by_importing_it(example: str) -> None:
    """
    The name must be bound exactly once in the file, by the `helpers` import.

    A local assignment is the obvious way to shadow it, but a parameter, a
    `for` target, a walrus, a `with ... as`, an `except ... as` or a second
    import bind it just as well, and every one of those would leave the judge
    reading something other than the shared constant while the call site still
    spells `AUDIO_JUDGE_CRITERIA`. Counting bindings catches all of them without
    resolving scopes.
    """
    tree = parse(example)
    bound = [node for name, node in bindings(tree) if name == CRITERIA_NAME]

    assert len(bound) == 1, (
        f"{example} binds {CRITERIA_NAME} {len(bound)} times. It must be bound "
        "exactly once, by importing it from `helpers`."
    )
    assert isinstance(bound[0], ast.alias), (
        f"{example} binds {CRITERIA_NAME} with a "
        f"{type(bound[0]).__name__} rather than an import. Import the shared "
        "constant and leave the name alone."
    )


@pytest.mark.parametrize("example", AUDIO_EXAMPLES)
def test_never_shadows_the_list_builtin(example: str) -> None:
    """
    `criteria=list(AUDIO_JUDGE_CRITERIA)` only means what it looks like while
    `list` is the builtin. Rebinding it would let the accepted form return
    anything at all.
    """
    tree = parse(example)
    shadows = [node for name, node in bindings(tree) if name == LIST_BUILTIN]
    assert not shadows, (
        f"{example} rebinds `{LIST_BUILTIN}`, so `list(...)` around the criteria "
        "no longer means the builtin copy."
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
