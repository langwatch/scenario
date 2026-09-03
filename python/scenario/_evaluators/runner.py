"""
Runs the evaluators attached to a scenario once the run has a verdict, and
applies their results to the run: a required evaluator that fails fails the
scenario, a score only reports.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Set

from opentelemetry.sdk.trace import ReadableSpan

from scenario.evaluators import (
    EvaluationCost,
    EvaluationResult,
    EvaluatorMapping,
    ScenarioEvaluator,
)
from scenario.types import ScenarioResult

from .api import EvaluatorSpec
from .inference import infer_evaluator_mappings
from .resolve_inputs import (
    EvaluatorInputContext,
    ResolvedFailed,
    ResolvedSkipped,
    ResolvedValue,
    reads_trace,
    resolve_input,
    stringify,
)

logger = logging.getLogger("scenario.evaluators.runner")

#: The largest ``inputs`` value an evaluation result carries.
EVALUATION_INPUT_MAX_CHARS = 2000


@dataclass
class RunEvaluatorsDeps:
    """What the runner needs from the run and from LangWatch."""

    get_evaluator_spec: Callable[[str], Awaitable[Optional[EvaluatorSpec]]]
    evaluate: Callable[..., Awaitable[Dict[str, Any]]]
    #: Spans of the run collected so far, local and remote.
    get_spans: Callable[[], List[ReadableSpan]]
    #: Fetches the remote traces of the run into the span collector, waiting
    #: the configured budget. Called at most once, only when a trace mapping
    #: found nothing in the messages and the local spans.
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
    data: Dict[str, Any]
    inputs: Dict[str, str]
    skipped: Optional[str] = None
    failed: Optional[str] = None


def _resolve_all(
    *,
    spec: EvaluatorSpec,
    mappings: Dict[str, EvaluatorMapping],
    explicit_ids: Set[str],
    context: EvaluatorInputContext,
) -> _ResolvedInputs:
    """
    Resolves every mapping. An input that resolves to nothing reports (skip
    or fail) when the evaluator requires it or the author mapped it by hand;
    an inferred optional input that resolves to nothing is left out of the
    call.
    """
    resolved = _ResolvedInputs(data={}, inputs={})
    required_ids = {spec_input.id for spec_input in spec.inputs if spec_input.required}
    for input_id, mapping in mappings.items():
        outcome = resolve_input(mapping=mapping, context=context)
        if isinstance(outcome, ResolvedValue):
            resolved.data[input_id] = _coerce_data_value(input_id, outcome.value)
            resolved.inputs[input_id] = _truncate(stringify(outcome.value))
            continue
        if input_id not in required_ids and input_id not in explicit_ids:
            continue
        if isinstance(outcome, ResolvedSkipped):
            resolved.skipped = resolved.skipped or outcome.reason
        elif isinstance(outcome, ResolvedFailed):
            resolved.failed = resolved.failed or outcome.reason
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


async def _run_one(
    *,
    attachment: ScenarioEvaluator,
    context: Callable[[], EvaluatorInputContext],
    trace_id: Optional[str],
    deps: RunEvaluatorsDeps,
    fetch_once: Callable[[], Awaitable[None]],
) -> EvaluationResult:
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
        field_names=list(context().fields.keys()),
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

    explicit_ids = set(attachment.mappings.keys())
    resolved = _resolve_all(
        spec=spec, mappings=mappings, explicit_ids=explicit_ids, context=context()
    )
    if (
        resolved.failed
        and deps.fetch_remote_traces is not None
        and any(reads_trace(mapping) for mapping in mappings.values())
    ):
        await fetch_once()
        resolved = _resolve_all(
            spec=spec, mappings=mappings, explicit_ids=explicit_ids, context=context()
        )
    if resolved.skipped:
        return EvaluationResult(
            evaluator_id=spec.evaluator_id,
            name=spec.name,
            status="skipped",
            required=required,
            details=resolved.skipped,
            inputs=resolved.inputs,
        )
    if resolved.failed:
        return EvaluationResult(
            evaluator_id=spec.evaluator_id,
            name=spec.name,
            status="failed",
            required=required,
            passed=False,
            details=resolved.failed,
            inputs=resolved.inputs,
        )

    try:
        response = await deps.evaluate(
            evaluator_ref=ref,
            data=resolved.data,
            settings=attachment.settings,
            trace_id=trace_id,
        )
    except Exception as error:
        return EvaluationResult(
            evaluator_id=spec.evaluator_id,
            name=spec.name,
            status="error",
            required=required,
            details=str(error),
            inputs=resolved.inputs,
        )
    return _from_api_response(
        response=response,
        evaluator_id=spec.evaluator_id,
        name=spec.name,
        required=required,
        inputs=resolved.inputs,
    )


async def run_scenario_evaluators(
    *,
    evaluators: Sequence[ScenarioEvaluator],
    context: EvaluatorInputContext,
    trace_id: Optional[str],
    deps: RunEvaluatorsDeps,
) -> List[EvaluationResult]:
    """
    Runs every evaluator of the scenario in parallel and returns one result
    per evaluator, in the order the scenario lists them. Never raises: a
    failure to load or call an evaluator is an ``error`` result.
    """
    remote_fetch: Optional[asyncio.Future[None]] = None

    async def fetch_remote() -> None:
        if deps.fetch_remote_traces is None:
            return
        try:
            await deps.fetch_remote_traces()
        except Exception as error:
            logger.warning("Remote trace fetch for evaluators failed: %s", error)

    async def fetch_once() -> None:
        nonlocal remote_fetch
        if remote_fetch is None:
            remote_fetch = asyncio.ensure_future(fetch_remote())
        await remote_fetch

    def context_with_spans() -> EvaluatorInputContext:
        return EvaluatorInputContext(
            messages=context.messages,
            description=context.description,
            criteria=context.criteria,
            fields=context.fields,
            spans=deps.get_spans(),
        )

    return list(
        await asyncio.gather(
            *[
                _run_one(
                    attachment=attachment,
                    context=context_with_spans,
                    trace_id=trace_id,
                    deps=deps,
                    fetch_once=fetch_once,
                )
                for attachment in evaluators
            ]
        )
    )


def apply_evaluations_to_result(
    *, result: ScenarioResult, evaluations: Sequence[EvaluationResult]
) -> ScenarioResult:
    """
    Applies evaluations to the run result: a required evaluator that failed
    fails the run and its reason joins the reasoning. Scores never gate.
    """
    result.evaluations = list(evaluations)
    gating = [
        evaluation
        for evaluation in evaluations
        if evaluation.required and evaluation.status == "failed"
    ]
    if not gating:
        return result
    reasons = [
        f"Evaluator {evaluation.name} failed"
        + (f": {evaluation.details}" if evaluation.details else "")
        for evaluation in gating
    ]
    result.success = False
    result.reasoning = "\n".join(part for part in [result.reasoning, *reasons] if part)
    return result
