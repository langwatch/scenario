"""The red-team report must fail closed (#888).

A security report that renders a compromised or unanalyzed run as green is
worse than no report. These tests pin the four fail-open paths:

1. analyzer failure / unrecognized break_severity → "analysis failed" state,
   never a green "none";
2. the JS writer's legacy "broken" status is normalized by the dashboard;
3. (JS-side, see red-team-report.unit.test.ts) judge infra failures file as
   errored;
4. an early exit because the ATTACK achieved its objective files as broke,
   never held.
"""

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from scenario.red_team_agent import (
    EARLY_EXIT_OBJECTIVE_PREFIX,
    RedTeamAgent,
)
from scenario.report._risk import _compound_risk, _status
from scenario.report._save import save_redteam_report


def _make_agent() -> RedTeamAgent:
    return RedTeamAgent.crescendo(target="test target", model="openai/gpt-4")


def _make_result(*, success: bool, reasoning: str = "judged") -> SimpleNamespace:
    return SimpleNamespace(
        success=success,
        reasoning=reasoning,
        messages=[
            {"role": "user", "content": "attack"},
            {"role": "assistant", "content": "response"},
        ],
        passed_criteria=[],
        failed_criteria=[],
        total_time=1.0,
        agent_time=0.5,
    )


def _saved_report(tmp_path, **kwargs) -> dict:
    import json

    path = save_redteam_report(out_dir=tmp_path, **kwargs)
    return json.loads(path.read_text())


class TestAnalyzerFailsClosed:
    def test_raising_analyzer_marks_analysis_failed_on_a_broke_run(self, tmp_path):
        with patch(
            "scenario.report._save.litellm.completion",
            side_effect=RuntimeError("429 rate limited"),
        ):
            report = _saved_report(
                tmp_path,
                result=_make_result(success=False),
                red_team=_make_agent(),
                test_name="pii_leak",
            )

        assert report["analysis_failed"] is True
        # A compromised run whose analysis failed must never carry the green
        # "none" break severity — the status-derived floor is "partial".
        assert report["break_severity"] == "partial"
        assert "(analyzer failed:" in report["failure_summary"]

    def test_raising_analyzer_on_a_held_run_still_flags_the_analysis(self, tmp_path):
        with patch(
            "scenario.report._save.litellm.completion",
            side_effect=RuntimeError("timeout"),
        ):
            report = _saved_report(
                tmp_path,
                result=_make_result(success=True),
                red_team=_make_agent(),
                test_name="pii_leak",
            )

        assert report["analysis_failed"] is True
        assert report["break_severity"] == "none"

    def test_unrecognized_break_severity_is_analysis_failure_not_none(self, tmp_path):
        fake_choice = SimpleNamespace(
            message=SimpleNamespace(content='{"break_severity": "catastrophic"}')
        )
        fake_resp = SimpleNamespace(choices=[fake_choice])
        with patch(
            "scenario.report._save.litellm.completion", return_value=fake_resp
        ):
            report = _saved_report(
                tmp_path,
                result=_make_result(success=False),
                red_team=_make_agent(),
                test_name="pii_leak",
            )

        assert report["analysis_failed"] is True
        assert report["break_severity"] == "partial"

    def test_analysis_failed_run_renders_at_scenario_severity_not_green(self):
        report = {
            "status": "broke",
            "success": False,
            "severity": "high",
            "break_severity": "partial",
            "analysis_failed": True,
        }
        # Same "unresolved" semantics as an errored run: fall back to the
        # scenario severity so the card demands attention instead of green.
        assert _compound_risk(report) == "high"

    def test_skipping_analysis_deliberately_is_not_an_analysis_failure(self, tmp_path):
        report = _saved_report(
            tmp_path,
            result=_make_result(success=False),
            red_team=_make_agent(),
            test_name="pii_leak",
            analyze=False,
        )

        assert report["analysis_failed"] is False
        # Status-derived fallback still applies: a broke run reads partial.
        assert report["break_severity"] == "partial"


class TestStatusVocabulary:
    def test_dashboard_normalizes_the_legacy_js_broken_status(self):
        assert _status({"status": "broken", "success": False}) == "broke"

    def test_python_statuses_pass_through(self):
        assert _status({"status": "held", "success": True}) == "held"
        assert _status({"status": "broke", "success": False}) == "broke"
        assert _status({"status": "errored", "success": False}) == "errored"


class TestEarlyExitObjectiveAchieved:
    def test_files_as_broke_not_held(self, tmp_path):
        result = _make_result(
            success=True,
            reasoning=f"{EARLY_EXIT_OBJECTIVE_PREFIX} on turn 3 (score >= 9)",
        )
        report = _saved_report(
            tmp_path,
            result=result,
            red_team=_make_agent(),
            test_name="pii_leak",
            analyze=False,
        )

        assert report["status"] == "broke"
        assert report["success"] is False

    def test_dashboard_never_buckets_a_legacy_early_exit_report_as_held(self):
        # Reports written before this fix carry status "held" with the
        # objective-achieved reasoning — the dashboard must re-bucket them.
        legacy = {
            "status": "held",
            "success": True,
            "reasoning": f"{EARLY_EXIT_OBJECTIVE_PREFIX} on turn 2",
        }
        assert _status(legacy) == "broke"

    def test_agent_early_exit_message_carries_the_shared_prefix(self):
        agent = _make_agent()
        agent.success_score = 9
        agent.success_confirm_turns = 1
        agent._turn_scores = {1: (10, "")}
        assert agent.check_early_exit() is True


class TestErroredRunsKeepNoVerdict:
    def test_error_with_no_transcript_files_as_errored(self, tmp_path):
        report = _saved_report(
            tmp_path,
            result=None,
            red_team=_make_agent(),
            test_name="pii_leak",
            error="connection refused",
            analyze=False,
        )

        assert report["status"] == "errored"
        assert report["break_severity"] == "none"
