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
import symtable
from pathlib import Path
from typing import Final, NamedTuple

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


class Binding(NamedTuple):
    """One scope's binding of a name, as CPython's symbol table sees it."""

    scope: str
    imported: bool
    assigned: bool
    parameter: bool


def bindings(example: str, name: str) -> list[Binding]:
    """
    Every scope in the file that binds `name`, according to CPython's own
    symbol table.

    Walking the AST for binding forms means enumerating them, and the
    enumeration is what keeps turning out to be incomplete: assignment, then
    parameters and `for` targets and walrus and `with ... as` and
    `except ... as`, then `def` and `class`, then `match` patterns. `symtable`
    is the binder the interpreter itself uses, so it has no such list to get
    wrong, and it reports nested scopes (functions, lambdas, comprehensions,
    classes) rather than only the module.

    `assigned` is the discriminator that matters here: a name bound purely by
    an import reports `imported` and not `assigned`, and anything else binding
    it as well, including a `def` or `class` of the same name, turns
    `assigned` on.
    """
    table = symtable.symtable((EXAMPLES / example).read_text(), example, "exec")
    found: list[Binding] = []

    def visit(scope: symtable.SymbolTable, path: str) -> None:
        for symbol in scope.get_symbols():
            if symbol.get_name() != name:
                continue
            binding = Binding(
                scope=path,
                imported=symbol.is_imported(),
                assigned=symbol.is_assigned(),
                parameter=symbol.is_parameter(),
            )
            if binding.imported or binding.assigned or binding.parameter:
                found.append(binding)
        for child in scope.get_children():
            visit(child, f"{path}.{child.get_name()}")

    visit(table, "<module>")
    return found


@pytest.mark.parametrize("example", AUDIO_EXAMPLES)
def test_binds_the_criteria_name_only_by_importing_it(example: str) -> None:
    """
    The name must be bound in exactly one scope, the module's, and there by an
    import and nothing else.

    A local assignment is the obvious way to shadow it, but a parameter, a
    `for` target, a walrus, a `with ... as`, an `except ... as`, a `def`, a
    `class`, a `match` pattern or a second import all bind it just as well, and
    every one of those leaves the judge reading something other than the shared
    constant while the call site still spells AUDIO_JUDGE_CRITERIA.
    """
    found = bindings(example, CRITERIA_NAME)

    assert [binding.scope for binding in found] == ["<module>"], (
        f"{example} binds {CRITERIA_NAME} in "
        f"{[binding.scope for binding in found] or 'no scope at all'}. It must be "
        "bound once, at module level, by importing it from `helpers`."
    )
    assert found[0].imported and not found[0].assigned, (
        f"{example} binds {CRITERIA_NAME} at module level by something other than "
        f"an import ({found[0]}). Import the shared constant and leave the name "
        "alone: a `def` or `class` of that name shadows it just as an assignment "
        "would."
    )


@pytest.mark.parametrize("example", AUDIO_EXAMPLES)
def test_never_shadows_the_list_builtin(example: str) -> None:
    """
    `criteria=list(AUDIO_JUDGE_CRITERIA)` only means what it looks like while
    `list` is the builtin. Rebinding it, in any scope and by any means, would
    let the accepted form return anything at all.
    """
    found = bindings(example, LIST_BUILTIN)
    assert not found, (
        f"{example} rebinds `{LIST_BUILTIN}` ({found}), so `list(...)` around the "
        "criteria no longer means the builtin copy."
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
