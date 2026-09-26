"""
The judge's per-criterion verdict: the finish_test tool schema, the prompt
rules on reading criteria, and the mapping of the answers back onto the
declared criteria. The JavaScript SDK uses the same text; keep them in sync.
"""

import re
from dataclasses import dataclass
from typing import Any, List, Literal, Optional, Sequence, cast

from ..types import CriterionResult, CriterionStatus


REQUIREMENT_DESCRIPTION = (
    "This criterion restated as a positive requirement the agent must "
    "satisfy. A fail condition such as 'fail if X', 'fail only if X', 'pass "
    "unless X' or 'the agent must not X' becomes 'the agent does not X'."
)

CRITERION_REASONING_DESCRIPTION = (
    "What the conversation and the collected evidence show about this "
    "requirement alone, pointing at the moment that decides it. Written "
    "before the status. When the status is inconclusive, name the evidence "
    "that was missing."
)

STATUS_DESCRIPTION = (
    "passed: the agent satisfied the requirement (for a fail condition, the "
    "condition did not happen). failed: the agent did not satisfy it (for a "
    "fail condition, the condition happened). inconclusive: the evidence to "
    "decide is not available."
)

SUMMARY_DESCRIPTION = (
    "A short summary of the verdict across all criteria, written after "
    "judging each one."
)

PER_CRITERION_RULES = [
    "Judge each criterion on its own: restate it as a positive requirement, "
    "check the conversation and the collected evidence for that requirement "
    "alone, write the reasoning, then choose its status. The outcome of one "
    "criterion never decides another.",
    "passed means the agent satisfied the requirement. A criterion phrased as "
    'a fail condition ("fail if X", "fail only if X", "pass unless X", "the '
    'agent must not X") passes when X did not happen and fails when X '
    "happened.",
    "When the evidence to decide a criterion is not available (the "
    "conversation ended before the moment it depends on, or it depends on "
    "internal behavior that left no trace), mark it inconclusive and name the "
    "missing evidence in its reasoning instead of guessing.",
]

_STATUSES = ("passed", "failed", "inconclusive")
_LEGACY_STATUS = {"true": "passed", "false": "failed", "inconclusive": "inconclusive"}

RunVerdict = Literal["success", "failure", "inconclusive"]


def criteria_keys(criteria: Sequence[str]) -> List[str]:
    """Sanitized schema property names for each criterion.

    The single source of truth for these keys: the finish_test schema
    declares them and parse_criterion_verdicts maps the answers back by them.
    """
    return [
        re.sub(r"[^a-zA-Z0-9]", "_", c.replace(" ", "_").replace("'", "").lower())[:70]
        for c in criteria
    ]


def build_finish_test_tool(criteria: Sequence[str]) -> dict:
    keys = criteria_keys(criteria)
    return {
        "type": "function",
        "function": {
            "name": "finish_test",
            "description": (
                "Complete the test with a verdict on each criterion, judged one by one"
            ),
            "strict": True,
            "parameters": {
                "type": "object",
                "properties": {
                    "criteria": {
                        "type": "object",
                        "properties": {
                            keys[idx]: {
                                "type": "object",
                                "description": f"Criterion {idx + 1}: {criterion}",
                                "properties": {
                                    "requirement": {
                                        "type": "string",
                                        "description": REQUIREMENT_DESCRIPTION,
                                    },
                                    "reasoning": {
                                        "type": "string",
                                        "description": CRITERION_REASONING_DESCRIPTION,
                                    },
                                    "status": {
                                        "type": "string",
                                        "enum": list(_STATUSES),
                                        "description": STATUS_DESCRIPTION,
                                    },
                                },
                                "required": ["requirement", "reasoning", "status"],
                                "additionalProperties": False,
                            }
                            for idx, criterion in enumerate(criteria)
                        },
                        "required": keys,
                        "additionalProperties": False,
                        "description": "The verdict on each criterion",
                    },
                    "reasoning": {
                        "type": "string",
                        "description": SUMMARY_DESCRIPTION,
                    },
                },
                "required": ["criteria", "reasoning"],
                "additionalProperties": False,
            },
        },
    }


@dataclass
class CriterionVerdicts:
    verdict: RunVerdict
    criteria: List[CriterionResult]
    passed_criteria: List[str]
    failed_criteria: List[str]
    inconclusive_criteria: List[str]


def _read_answer(answer: Any) -> Optional[CriterionResult]:
    """One criterion's answer, without the criterion text. A model that
    flattens the object to a bare status (or the legacy true/false words)
    still counts; anything else is a missing answer."""
    if isinstance(answer, bool):
        return CriterionResult(criterion="", status="passed" if answer else "failed")
    if isinstance(answer, str):
        status = answer if answer in _STATUSES else _LEGACY_STATUS.get(answer)
        if status is None:
            return None
        return CriterionResult(criterion="", status=cast(CriterionStatus, status))
    if isinstance(answer, dict):
        status = answer.get("status")
        if status not in _STATUSES:
            return None
        requirement = answer.get("requirement")
        reasoning = answer.get("reasoning")
        return CriterionResult(
            criterion="",
            requirement=requirement if isinstance(requirement, str) else "",
            status=cast(CriterionStatus, status),
            reasoning=reasoning if isinstance(reasoning, str) else "",
        )
    return None


def parse_criterion_verdicts(
    criteria: Sequence[str], answers: Any
) -> CriterionVerdicts:
    """Maps the finish_test answers back onto the declared criteria, by
    schema key, and derives the run verdict from them: any failed criterion
    fails the run, otherwise any inconclusive one (or no criteria at all)
    makes it inconclusive, otherwise it passes. A criterion the model left out
    fails closed."""
    answer_map = answers if isinstance(answers, dict) else {}
    results: List[CriterionResult] = []
    for criterion, key in zip(criteria, criteria_keys(criteria)):
        answer = _read_answer(answer_map.get(key))
        if answer is None:
            results.append(
                CriterionResult(
                    criterion=criterion,
                    status="failed",
                    reasoning="The judge returned no verdict for this criterion.",
                )
            )
        else:
            results.append(answer.model_copy(update={"criterion": criterion}))

    def with_status(*statuses: CriterionStatus) -> List[str]:
        return [r.criterion for r in results if r.status in statuses]

    inconclusive = with_status("inconclusive")
    verdict: RunVerdict
    if any(r.status == "failed" for r in results):
        verdict = "failure"
    elif inconclusive or not results:
        verdict = "inconclusive"
    else:
        verdict = "success"

    return CriterionVerdicts(
        verdict=verdict,
        criteria=results,
        passed_criteria=with_status("passed"),
        # An inconclusive criterion stays among the failed ones: success is
        # still "nothing failed", and the reporters read that list.
        failed_criteria=with_status("failed", "inconclusive"),
        inconclusive_criteria=inconclusive,
    )
