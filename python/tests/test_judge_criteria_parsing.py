"""Tests for JudgeAgent's defensive parsing of the `criteria` field on the
finish_test tool call (see https://github.com/langwatch/scenario/issues/161).

The LLM occasionally serializes the nested `criteria` object as a JSON string
instead of a proper dict — a known failure mode with dynamically-named
property schemas (sanitized criterion text used as keys).

JudgeAgent must:
  - Parse a stringified-but-valid JSON dict and evaluate criteria normally.
  - Fail closed on a malformed payload by returning an inconclusive
    ScenarioResult (`success=False`), rather than silently treating the
    response as a passing scenario. The latter would be a false green when
    `verdict == "success"` and `criteria` fell back to an empty dict.
"""

import json
from types import SimpleNamespace

from scenario import JudgeAgent
from scenario.types import ScenarioResult


def _mock_finish_test_response(args: dict) -> SimpleNamespace:
    """Build a minimal litellm-style ModelResponse with a single finish_test tool call.

    Mirrors the helper used in test_judge_force_verdict_hardening.py.
    """
    tc = SimpleNamespace(
        id="tc-final",
        type="function",
        function=SimpleNamespace(
            name="finish_test", arguments=json.dumps(args)
        ),
    )
    message = SimpleNamespace(tool_calls=[tc], content=None)
    choice = SimpleNamespace(message=message)
    return SimpleNamespace(choices=[choice])


class TestStringifiedCriteriaIsParsed:
    """The happy path of the original #161 fix: a string that is valid JSON
    should be parsed into a dict and evaluated like a normal criteria object."""

    def test_stringified_criteria_dict_is_parsed_and_evaluated(self):
        agent = JudgeAgent(criteria=["A", "B"], model="openai/gpt-5-mini")
        response = _mock_finish_test_response(
            {
                "verdict": "success",
                "reasoning": "both criteria met",
                # criteria sent as a JSON-string instead of an object — the
                # exact LLM failure mode reported in #161.
                "criteria": json.dumps({"a": "true", "b": "true"}),
            }
        )

        result = agent._parse_response(response, ["A", "B"], messages=[])

        assert isinstance(result, ScenarioResult)
        assert result.success is True
        assert set(result.passed_criteria) == {"A", "B"}
        assert result.failed_criteria == []

    def test_stringified_criteria_with_failure_still_fails(self):
        """Stringified criteria parsing should not bias toward success — a
        parsed dict with a failed criterion still yields success=False."""
        agent = JudgeAgent(criteria=["A", "B"], model="openai/gpt-5-mini")
        response = _mock_finish_test_response(
            {
                "verdict": "success",  # LLM said success at the top level…
                "reasoning": "claimed success",
                # …but one criterion failed inside the (stringified) payload.
                "criteria": json.dumps({"a": "true", "b": "false"}),
            }
        )

        result = agent._parse_response(response, ["A", "B"], messages=[])

        assert result.success is False
        assert result.passed_criteria == ["A"]
        assert result.failed_criteria == ["B"]


class TestMalformedCriteriaIsInconclusive:
    """The hardening Drew asked for in PR #196: malformed payloads must not
    produce a false-green ScenarioResult."""

    def test_unparseable_criteria_string_returns_inconclusive_not_success(self):
        """The exact false-green case: verdict=='success' + criteria is a
        broken string. Before the fix, this evaluated to success=True because
        the empty-dict fallback made failed_criteria empty. It must now fail
        closed."""
        agent = JudgeAgent(criteria=["A", "B"], model="openai/gpt-5-mini")
        response = _mock_finish_test_response(
            {
                "verdict": "success",
                "reasoning": "claims success",
                "criteria": "{not valid json at all",
            }
        )

        result = agent._parse_response(response, ["A", "B"], messages=[])

        assert isinstance(result, ScenarioResult)
        assert result.success is False, (
            "A malformed criteria payload must not report a passing scenario "
            "even when the top-level verdict says 'success'."
        )
        assert result.passed_criteria == []
        assert set(result.failed_criteria) == {"A", "B"}
        assert result.reasoning is not None
        assert "malformed" in result.reasoning.lower()

    def test_non_dict_non_string_criteria_returns_inconclusive(self):
        """A list (or any other non-dict, non-string type) is also malformed
        and must fail closed rather than crashing on `.values()`."""
        agent = JudgeAgent(criteria=["A", "B"], model="openai/gpt-5-mini")
        response = _mock_finish_test_response(
            {
                "verdict": "success",
                "reasoning": "claims success",
                "criteria": ["true", "true"],  # wrong shape entirely
            }
        )

        result = agent._parse_response(response, ["A", "B"], messages=[])

        assert result.success is False
        assert result.passed_criteria == []
        assert set(result.failed_criteria) == {"A", "B"}
        assert result.reasoning is not None
        assert "list" in result.reasoning.lower()

    def test_stringified_non_dict_json_returns_inconclusive(self):
        """A string that parses successfully but yields a non-dict (e.g. a
        JSON-encoded list) must also fail closed. This exercises both
        defensive branches in sequence: the JSON-string parse succeeds, then
        the dict-type check catches the wrong shape."""
        agent = JudgeAgent(criteria=["A", "B"], model="openai/gpt-5-mini")
        response = _mock_finish_test_response(
            {
                "verdict": "success",
                "reasoning": "claims success",
                # Valid JSON, but the wrong shape — parses to a list.
                "criteria": json.dumps(["true", "true"]),
            }
        )

        result = agent._parse_response(response, ["A", "B"], messages=[])

        assert result.success is False
        assert result.passed_criteria == []
        assert set(result.failed_criteria) == {"A", "B"}
        assert result.reasoning is not None
        assert "list" in result.reasoning.lower()

    def test_malformed_criteria_preserves_original_reasoning_for_debugging(self):
        """The fail-closed reasoning should surface the original LLM reasoning
        so an operator can see what the judge tried to say before we discarded
        the verdict."""
        agent = JudgeAgent(criteria=["A"], model="openai/gpt-5-mini")
        response = _mock_finish_test_response(
            {
                "verdict": "success",
                "reasoning": "the agent was perfect in every way",
                "criteria": "{broken",
            }
        )

        result = agent._parse_response(response, ["A"], messages=[])

        assert result.reasoning is not None
        assert "the agent was perfect in every way" in result.reasoning
