"""
Ref: specs/scenario-evaluators.feature

The evaluations API client: a saved evaluator declares its own inputs, and
the catalogue is the fallback for a record without fields.
"""

from typing import Any, Dict, List, Optional

import httpx
import pytest

from scenario._evaluators.api import EvaluationsApiAuth, EvaluationsApiClient, EvaluatorInput

AUTH = EvaluationsApiAuth(endpoint="http://localhost:5560", api_key="sk-test", project_id="")


class _FakeClient:
    """Stands in for httpx.AsyncClient: answers by path, records every request."""

    def __init__(self, bodies: Dict[str, Any]) -> None:
        self.bodies = bodies
        self.requests: List[Dict[str, Any]] = []

    async def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        path = httpx.URL(url).path
        self.requests.append({"method": method, "path": path, **kwargs})
        body: Optional[Any] = self.bodies.get(path)
        if body is None:
            return httpx.Response(404, text="not found")
        return httpx.Response(200, json=body)


class TestSavedEvaluatorSpec:
    """Scenario: A saved evaluator declares its own inputs."""

    @pytest.mark.asyncio
    async def test_lists_required_and_optional_inputs_and_passed(self):
        fake = _FakeClient(
            {
                "/api/evaluators/answer-check": {
                    "id": "eval_1",
                    "name": "Answer check",
                    "config": {"evaluatorType": "custom/code"},
                    "fields": [
                        {"identifier": "output", "type": "str"},
                        {"identifier": "contexts", "type": "list", "optional": True},
                    ],
                    "outputFields": [{"identifier": "passed", "type": "bool"}],
                }
            }
        )
        spec = await EvaluationsApiClient(AUTH, client=fake).get_evaluator_spec("evaluators/answer-check")  # type: ignore[arg-type]  # the fake answers request() like an AsyncClient
        assert spec is not None
        assert spec.evaluator_id == "eval_1"
        assert spec.name == "Answer check"
        assert spec.inputs == [
            EvaluatorInput(id="output", required=True),
            EvaluatorInput(id="contexts", required=False),
        ]
        assert spec.produces_passed is True
        assert [r["path"] for r in fake.requests] == ["/api/evaluators/answer-check"]

    @pytest.mark.asyncio
    async def test_a_score_only_saved_evaluator_does_not_answer_passed(self):
        fake = _FakeClient(
            {
                "/api/evaluators/quality": {
                    "id": "eval_2",
                    "name": "Quality",
                    "fields": [{"identifier": "output", "type": "str"}],
                    "outputFields": [{"identifier": "score", "type": "float"}],
                }
            }
        )
        spec = await EvaluationsApiClient(AUTH, client=fake).get_evaluator_spec("evaluators/quality")  # type: ignore[arg-type]  # the fake answers request() like an AsyncClient
        assert spec is not None
        assert spec.produces_passed is False

    @pytest.mark.asyncio
    async def test_falls_back_to_the_catalogue_without_fields(self):
        fake = _FakeClient(
            {
                "/api/evaluators/exact": {
                    "id": "eval_3",
                    "name": "Exact",
                    "config": {"evaluatorType": "langevals/exact_match"},
                    "fields": [],
                },
                "/api/evaluations/list": {
                    "evaluators": {
                        "langevals/exact_match": {
                            "name": "Exact Match",
                            "requiredFields": ["output", "expected_output"],
                            "optionalFields": [],
                            "result": {"passed": {}},
                        }
                    }
                },
            }
        )
        spec = await EvaluationsApiClient(AUTH, client=fake).get_evaluator_spec("evaluators/exact")  # type: ignore[arg-type]  # the fake answers request() like an AsyncClient
        assert spec is not None
        assert [i.id for i in spec.inputs] == ["output", "expected_output"]
