"""
Runs the evaluators attached to a scenario once the run has a verdict, and
applies their results to the run: a required evaluator that fails fails the
scenario, a score only reports.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Set, Union

from scenario._state_views import stringify
from scenario.evaluators import (
    EvaluationCost,
    EvaluationResult,
    ScenarioEvaluator,
)
from scenario.scenario_state import ScenarioState
from scenario.types import ScenarioResult

from .api import EvaluatorSpec
from .inference import infer_evaluator_mappings
from .resolve_mapping import (
    ResolvedError,
    ResolvedValue,
    distinct_message_trace_ids,
    resolve_mapping,
)

logger = logging.getLogger("scenario.evaluators.runner")

#: The largest ``inputs`` value an evaluation result carries.
EVALUATION_INPUT_MAX_CHARS = 2000


@dataclass
class RunEvaluatorsDeps:
    """What the runner needs from LangWatch and from the run."""

    get_evaluator_spec: Callable[[str], Awaitable[Optional[EvaluatorSpec]]]
    evaluate: Callable[..., Awaitable[Dict[str, Any]]]
    #: Fetches the remote traces of the run into the span collector, waiting
    #: the configured budget. Called at most once, only when a mapping read
    #: the trace and found nothing while the messages carry trace ids.
    fetch_remote_traces: Optional[Callable[[], Awaitable[None]]] = None


def _truncate(text: str) -> str:
    return text[:EVALUATION_INPUT_MAX_CHARS]


def _coerce_data_value(input_id: str, value: Any) -> Any:
    """
    Evaluators read contexts as a list. A field or a literal mapped to a
    contexts input arrives as one string, so it becomes a one-item list.
    """
    if input_id.lower().endswith("contexts") and isinstance(value, str):
        return [value]
    return value


@dataclass
class _ResolvedInputs:
    data: Dict[str, Any] = field(default_factory=dict)
    inputs: Dict[str, str] = field(default_factory=dict)
    skipped: Optional[str] = None
    error: Optional[str] = None
    #: A mapping read the trace and found nothing.
    wants_trace: bool = False


@dataclass
class _Prepared:
    attachment: ScenarioEvaluator
    spec: EvaluatorSpec
    required: bool
    mappings: Dict[str, Any]
    explicit_ids: Set[str]


async def _resolve_all(*, prepared: _Prepared, state: ScenarioState) -> _ResolvedInputs:
    """
    Resolves every mapping. An input that resolves to nothing reports a
    skip when the evaluator requires it or the author mapped it by hand; an
    inferred optional input that resolves to nothing is left out of the
    call. A mapping that raises reports an error.
    """
    resolved = _ResolvedInputs()
    required_ids = {spec_input.id for spec_input in prepared.spec.inputs if spec_input.required}
    for input_id, mapping in prepared.mappings.items():
        outcome = await resolve_mapping(mapping=mapping, state=state)
        if isinstance(outcome, ResolvedValue):
            resolved.data[input_id] = _coerce_data_value(input_id, outcome.value)
            resolved.inputs[input_id] = _truncate(stringify(outcome.value))
            continue
        if isinstance(outcome, ResolvedError):
            resolved.error = resolved.error or f"Mapping of {input_id} failed: {outcome.error}"
            continue
        resolved.wants_trace = resolved.wants_trace or outcome.read_trace
        if input_id not in required_ids and input_id not in prepared.explicit_ids:
            continue
        resolved.skipped = resolved.skipped or outcome.reason
    return resolved


def _cost(raw: Any) -> Optional[EvaluationCost]:
    if not isinstance(raw, dict):
        return None
    try:
        return EvaluationCost(currency=str(raw["currency"]), amount=float(raw["amount"]))
    except (KeyError, TypeError, ValueError):
        return None


def _from_api_response(
    *,
    response: Dict[str, Any],
    evaluator_id: str,
    name: str,
    required: bool,
    inputs: Dict[str, str],
) -> EvaluationResult:
    status = response.get("status")
    details = response.get("details")
    if status == "error":
        return EvaluationResult(
            evaluator_id=evaluator_id,
            name=name,
            status="error",
            required=required,
            details=str(details) if details is not None else None,
            inputs=inputs,
        )
    if status == "skipped":
        return EvaluationResult(
            evaluator_id=evaluator_id,
            name=name,
            status="skipped",
            required=required,
            details=str(details) if details is not None else None,
            cost=_cost(response.get("cost")),
            inputs=inputs,
        )
    passed = response.get("passed")
    score = response.get("score")
    label = response.get("label")
    return EvaluationResult(
        evaluator_id=evaluator_id,
        name=name,
        status="scored" if passed is None else ("passed" if passed else "failed"),
        required=required,
        passed=passed if isinstance(passed, bool) else None,
        score=float(score) if isinstance(score, (int, float)) else None,
        label=str(label) if label is not None else None,
        details=str(details) if details is not None else None,
        cost=_cost(response.get("cost")),
        inputs=inputs,
    )


async def _prepare(
    *, attachment: ScenarioEvaluator, state: ScenarioState, deps: RunEvaluatorsDeps
) -> Union[_Prepared, EvaluationResult]:
    """Loads the evaluator and completes its mappings."""
    ref = attachment.evaluator
    try:
        spec = await deps.get_evaluator_spec(ref)
    except Exception as error:
        return EvaluationResult(
            evaluator_id=ref,
            name=ref,
            status="error",
            required=bool(attachment.required),
            details=f"Could not load evaluator {ref}: {error}",
        )
    if spec is None:
        return EvaluationResult(
            evaluator_id=ref,
            name=ref,
            status="error",
            required=bool(attachment.required),
            details=f"Evaluator {ref} was not found in LangWatch",
        )

    required = spec.produces_passed if attachment.required is None else attachment.required
    mappings = infer_evaluator_mappings(
        inputs=[spec_input.id for spec_input in spec.inputs],
        field_names=list(state.fields.keys()),
        mappings=attachment.mappings,
    )
    unmapped = [
        spec_input.id
        for spec_input in spec.inputs
        if spec_input.required and spec_input.id not in mappings
    ]
    if unmapped:
        plural = "s" if len(unmapped) > 1 else ""
        return EvaluationResult(
            evaluator_id=spec.evaluator_id,
            name=spec.name,
            status="error",
            required=required,
            details=f"No mapping for the required input{plural} {', '.join(unmapped)} of {spec.name}",
        )
    return _Prepared(
        attachment=attachment,
        spec=spec,
        required=required,
        mappings=mappings,
        explicit_ids=set(attachment.mappings.keys()),
    )


async def _call_evaluator(
    *,
    prepared: _Prepared,
    resolved: _ResolvedInputs,
    trace_id: Optional[str],
    deps: RunEvaluatorsDeps,
) -> EvaluationResult:
    spec = prepared.spec
    if resolved.error:
        return EvaluationResult(
            evaluator_id=spec.evaluator_id,
            name=spec.name,
            status="error",
            required=prepared.required,
            details=resolved.error,
            inputs=resolved.inputs,
        )
    if resolved.skipped:
        return EvaluationResult(
            evaluator_id=spec.evaluator_id,
            name=spec.name,
            status="skipped",
            required=prepared.required,
            details=resolved.skipped,
            inputs=resolved.inputs,
        )
    try:
        response = await deps.evaluate(
            evaluator_ref=prepared.attachment.evaluator,
            data=resolved.data,
            settings=prepared.attachment.settings,
            trace_id=trace_id,
        )
    except Exception as error:
        return EvaluationResult(
            evaluator_id=spec.evaluator_id,
            name=spec.name,
            status="error",
            required=prepared.required,
            details=str(error),
            inputs=resolved.inputs,
        )
    return _from_api_response(
        response=response,
        evaluator_id=spec.evaluator_id,
        name=spec.name,
        required=prepared.required,
        inputs=resolved.inputs,
    )


async def run_scenario_evaluators(
    *,
    evaluators: Sequence[ScenarioEvaluator],
    state: ScenarioState,
    trace_id: Optional[str],
    deps: RunEvaluatorsDeps,
) -> List[EvaluationResult]:
    """
    Runs every evaluator of the scenario and returns one result per
    evaluator, in the order the scenario lists them. Mappings resolve one
    evaluator at a time against the state; the evaluate calls run in
    parallel. Never raises: a failure to load or call an evaluator is an
    ``error`` result.
    """
    fetch_lock = asyncio.Lock()
    fetched = False
    can_fetch = deps.fetch_remote_traces is not None and bool(
        distinct_message_trace_ids(state.messages)
    )

    async def fetch_once() -> None:
        nonlocal fetched
        async with fetch_lock:
            if fetched or deps.fetch_remote_traces is None:
                return
            fetched = True
            try:
                await deps.fetch_remote_traces()
            except Exception as error:
                logger.warning("Remote trace fetch for evaluators failed: %s", error)

    prepared_all = await asyncio.gather(
        *[_prepare(attachment=attachment, state=state, deps=deps) for attachment in evaluators]
    )

    calls: List[Awaitable[EvaluationResult]] = []
    for entry in prepared_all:
        if isinstance(entry, EvaluationResult):
            calls.append(asyncio.sleep(0, result=entry))
            continue
        fetched_before = fetched
        resolved = await _resolve_all(prepared=entry, state=state)
        if resolved.wants_trace and can_fetch and not fetched_before:
            await fetch_once()
            resolved = await _resolve_all(prepared=entry, state=state)
        calls.append(_call_evaluator(prepared=entry, resolved=resolved, trace_id=trace_id, deps=deps))
    return list(await asyncio.gather(*calls))


def _gates(evaluation: EvaluationResult) -> bool:
    """True when a required evaluator with this status fails the run."""
    return evaluation.required and evaluation.status in ("failed", "error")


def apply_evaluations_to_result(
    *, result: ScenarioResult, evaluations: Sequence[EvaluationResult]
) -> ScenarioResult:
    """
    Applies evaluations to the run result: a required evaluator that failed,
    or that could not run, fails the run and its reason joins the reasoning.
    Scores and skips never gate. The same rule the platform applies to a run
    it evaluates itself.
    """
    result.evaluations = list(evaluations)
    gating = [evaluation for evaluation in evaluations if _gates(evaluation)]
    if not gating:
        return result
    reasons = [
        f"Evaluator {evaluation.name} {'could not run' if evaluation.status == 'error' else 'failed'}"
        + (f": {evaluation.details}" if evaluation.details else "")
        for evaluation in gating
    ]
    result.success = False
    result.reasoning = "\n".join(part for part in [result.reasoning, *reasons] if part)
    return result
