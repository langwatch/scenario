"""
Structural guard for specs/voice-agents.feature — the behavioral contract.

Parses the feature file with the same Gherkin parser pytest-bdd uses and
asserts it is well-formed. Catches regressions where a scenario gets
dropped, a tag gets misspelled, or an AC is deleted without updating the
prove-it report.

This is the minimum-viable half of "BDD wiring." Full pytest-bdd binding
(one executable test per Scenario) is tracked as follow-up; local
environment collision with ``pytest-asyncio-concurrent`` breaks step
resolution and needs a dedicated pytest config layer to unblock.

When the full binding lands, this test should become redundant — every
scenario will be executed, making "are they parseable" trivially true.
Until then, this keeps the contract honest.
"""

from __future__ import annotations

import pathlib

import pytest
from pytest_bdd.gherkin_parser import get_gherkin_document


FEATURE_PATH = (
    pathlib.Path(__file__).parent.parent.parent.parent
    / "specs"
    / "voice-agents.feature"
)


@pytest.fixture(scope="module")
def parsed_feature():
    assert FEATURE_PATH.exists(), f"missing feature file: {FEATURE_PATH}"
    return get_gherkin_document(str(FEATURE_PATH))


def test_feature_file_parses_cleanly(parsed_feature):
    assert parsed_feature is not None
    assert parsed_feature.feature is not None
    assert parsed_feature.feature.name


def test_feature_file_declares_expected_scenario_count(parsed_feature):
    """
    The issue-350 contract is 108 scenarios:
      - 83 original
      - +4 for locked decision #9 (composable + branded voice agents)
      - +12 for @e2e demo parity (TESTING.md: every user-facing feature has
        a runnable example). 8 platform-demo + 4 cross-cutting SDK demos.
      - +3 for AC-14 (demo recordings: save_segments + opt-in + CI artifact).
      - +3 for AC-15 (auto-transcribe agent audio for non-multimodal judges).
      - +3 for AC-16 (audio messages render cleanly in the terminal).

    Any change to this count must be a deliberate contract update — and must
    be reflected in the prove-it report at
    docs/proposals/issue-350-prove-it-report.md.
    """
    scenarios = _collect_scenarios(parsed_feature)
    assert len(scenarios) == 108, (
        f"Expected 108 scenarios; found {len(scenarios)}. "
        "If this is an intentional contract change, update the count here "
        "AND regenerate docs/proposals/issue-350-prove-it-report.md."
    )


def test_every_scenario_has_at_least_one_given_and_one_then(parsed_feature):
    """
    Every scenario must have at minimum a Given setup and a Then assertion.
    When is not strictly required (valid Gherkin permits Given..Then for
    state-assertion scenarios like "result.X preserves existing fields").

    And/But steps inherit their kind from the preceding step, so a
    scenario like ``Given X / And Y / Then Z`` correctly covers both
    Given and Then (the And resolves to Given).
    """
    scenarios = _collect_scenarios(parsed_feature)
    offenders = []
    for scn in scenarios:
        covered = _keywords_covered_by(scn)
        missing = [kw for kw in ("given", "then") if kw not in covered]
        if missing:
            offenders.append((scn.name, missing))
    assert not offenders, (
        "scenarios missing Given and/or Then:\n"
        + "\n".join(f"  - {name}: missing {missing}" for name, missing in offenders)
    )


def test_every_scenario_is_tagged_unit_integration_or_e2e(parsed_feature):
    """Per TESTING.md, every scenario is @unit, @integration, or @e2e."""
    scenarios = _collect_scenarios(parsed_feature)
    valid = {"@unit", "@integration", "@e2e"}
    offenders = []
    for scn in scenarios:
        tags = {t.name for t in scn.tags}
        if not (tags & valid):
            offenders.append(scn.name)
    assert not offenders, (
        "scenarios missing @unit, @integration, or @e2e tag:\n"
        + "\n".join(f"  - {n}" for n in offenders)
    )


def test_tag_split_matches_prove_it_report(parsed_feature):
    """
    The prove-it report assumes 75 @unit / 8 @integration / 25 @e2e.
    §6 examples and §8 pain patterns are @e2e (happy paths via real examples,
    per TESTING.md). AC-14 adds 1 @unit + 2 @integration. AC-15 adds 3 @unit.
    AC-16 adds 3 @unit. If the split changes, the report must be updated in
    the same PR.
    """
    scenarios = _collect_scenarios(parsed_feature)
    unit = sum(1 for s in scenarios if "@unit" in {t.name for t in s.tags})
    integration = sum(
        1 for s in scenarios if "@integration" in {t.name for t in s.tags}
    )
    e2e = sum(1 for s in scenarios if "@e2e" in {t.name for t in s.tags})
    assert (unit, integration, e2e) == (75, 8, 25), (
        f"Expected 75 @unit / 8 @integration / 25 @e2e; found "
        f"{unit} / {integration} / {e2e}. "
        "Update docs/proposals/issue-350-prove-it-report.md alongside this change."
    )


# -------------------------------------------------------------------- #
# Helpers                                                               #
# -------------------------------------------------------------------- #


def _collect_scenarios(parsed_feature):
    """pytest-bdd's parser exposes children on feature; walk them."""
    children = parsed_feature.feature.children or []
    return [
        child.scenario
        for child in children
        if getattr(child, "scenario", None) is not None
    ]


def _step_keyword(step):
    # pytest-bdd's Gherkin parser normalises keywords as e.g. "Given ",
    # "When ", "Then ", "And " (trailing space included).
    return getattr(step, "keyword", "") or ""


def _keywords_covered_by(scn):
    """
    Return the set of {given/when/then} that are present after resolving
    And/But to the immediately-preceding step's keyword.

    Walks steps in order; an And or But step "inherits" the kind of the
    most recent Given/When/Then. The previous implementation returned the
    full {given, when, then} set whenever ANY And/But was present — which
    made the outer ``has_given and has_then`` check vacuous for every
    scenario that uses And. Now Given..And..And..And without a Then is
    correctly flagged as missing Then.
    """
    covered: set[str] = set()
    inherited: str | None = None
    for step in scn.steps:
        kw = _step_keyword(step).lower().strip()
        if kw in ("given", "when", "then"):
            covered.add(kw)
            inherited = kw
        elif kw in ("and", "but") and inherited is not None:
            covered.add(inherited)
    return covered
