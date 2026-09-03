"""
Evaluators on scenario runs: mapping inference, the evaluations API client,
input resolution and the runner. The public helpers live in
``scenario.evaluators``.
"""

from .api import (
    EvaluationsApiAuth,
    EvaluationsApiClient,
    EvaluationsApiError,
    EvaluatorInput,
    EvaluatorSpec,
    resolve_evaluations_api_auth,
)
from .inference import infer_evaluator_mappings, is_expected_like_input
from .resolve_inputs import (
    EvaluatorInputContext,
    ResolvedFailed,
    ResolvedInput,
    ResolvedSkipped,
    ResolvedValue,
    distinct_message_trace_ids,
    last_message_trace_id,
    resolve_input,
)
from .runner import (
    EVALUATION_INPUT_MAX_CHARS,
    RunEvaluatorsDeps,
    apply_evaluations_to_result,
    run_scenario_evaluators,
)

__all__ = [
    "EVALUATION_INPUT_MAX_CHARS",
    "EvaluationsApiAuth",
    "EvaluationsApiClient",
    "EvaluationsApiError",
    "EvaluatorInput",
    "EvaluatorInputContext",
    "EvaluatorSpec",
    "ResolvedFailed",
    "ResolvedInput",
    "ResolvedSkipped",
    "ResolvedValue",
    "RunEvaluatorsDeps",
    "apply_evaluations_to_result",
    "distinct_message_trace_ids",
    "infer_evaluator_mappings",
    "is_expected_like_input",
    "last_message_trace_id",
    "resolve_evaluations_api_auth",
    "resolve_input",
    "run_scenario_evaluators",
]
