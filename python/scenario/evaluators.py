"""
Attach LangWatch evaluators to scenario runs: the mapping helpers, the
evaluator attachment and the result one evaluator produces.

The mapping shape is the one the LangWatch platform stores on a test suite, so
a scenario defined in code and a scenario defined on the platform describe the
same thing.

Example:
    ```
    result = await scenario.run(
        name="chargeback totals by quarter",
        description="A fraud analyst asks for chargebacks per quarter.",
        agents=[MyAgent(), scenario.UserSimulatorAgent(), scenario.JudgeAgent(criteria=[...])],
        fields={"golden_sql": "SELECT ...", "table_schema": "CREATE TABLE ..."},
        evaluators=[
            scenario.evaluator(
                "ragas/sql_query_equivalence",
                required=True,
                mappings={
                    "output": scenario.trace.tool_call("run_sql").input,
                    "expected_output": scenario.field("golden_sql"),
                    "expected_contexts": scenario.field("table_schema"),
                },
            ),
            scenario.evaluator("evaluators/answer-quality-judge"),
        ],
    )
    assert result.success
    result.evaluations  # one EvaluationResult per evaluator
    ```
"""

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

EvaluatorMappingSourceId = Literal["conversation", "scenario", "trace"]

EvaluationStatus = Literal["passed", "failed", "scored", "skipped", "error"]


class EvaluatorMapping(BaseModel):
    """
    Where one evaluator input reads its value from.

    A ``source`` mapping names a source and a path:

    - conversation: ``["first_user_message"]``, ``["last_agent_message"]``,
      ``["transcript"]`` or ``["messages"]``
    - scenario: ``["situation"]``, ``["criteria"]`` or ``["fields", <name>]``
    - trace: ``["contexts"]`` or ``["tool_calls", <tool name>, "input" | "output"]``

    A ``value`` mapping carries a literal.
    """

    type: Literal["source", "value"]
    source_id: Optional[EvaluatorMappingSourceId] = None
    path: List[str] = Field(default_factory=list)
    value: Optional[str] = None

    def to_wire(self) -> Dict[str, Any]:
        if self.type == "value":
            return {"type": "value", "value": self.value}
        return {"type": "source", "sourceId": self.source_id, "path": list(self.path)}


class ToolCallMapping(BaseModel):
    """The input and the output of one tool call, as evaluator mappings."""

    input: EvaluatorMapping
    output: EvaluatorMapping


class ScenarioEvaluator(BaseModel):
    """
    One evaluator attached to a scenario run.

    Attributes:
        evaluator: A built-in type such as ``ragas/sql_query_equivalence`` or a
            saved evaluator as ``evaluators/<slug>``, the same reference the
            evaluate endpoint accepts.
        required: Whether a failing verdict fails the scenario. Defaults to
            True for an evaluator that answers pass or fail, and to False for a
            score-only one. A score never fails the scenario.
        mappings: Where each evaluator input reads from, keyed by input name.
            An input without a mapping is inferred from its name; a tool call
            is never inferred.
        settings: Per-run overrides of the evaluator settings.
    """

    evaluator: str
    required: Optional[bool] = None
    mappings: Dict[str, EvaluatorMapping] = Field(default_factory=dict)
    settings: Optional[Dict[str, Any]] = None


class EvaluationCost(BaseModel):
    currency: str
    amount: float


class EvaluationResult(BaseModel):
    """
    The result of one evaluator on a scenario run.

    Attributes:
        evaluator_id: The saved evaluator id, or the evaluator type when run
            by type.
        name: The evaluator name.
        status: ``passed``, ``failed``, ``scored``, ``skipped`` or ``error``.
        required: Whether a failed status fails the scenario.
        passed: The pass or fail verdict, when the evaluator answers one.
        score: The score, when the evaluator answers one.
        label: The label, when the evaluator answers one.
        details: The reason: judge details, "no golden_sql on this scenario",
            "no run_sql call in the trace".
        cost: What running the evaluator cost.
        inputs: The resolved input values, each cut to 2000 characters.
    """

    evaluator_id: str
    name: str
    status: EvaluationStatus
    required: bool
    passed: Optional[bool] = None
    score: Optional[float] = None
    label: Optional[str] = None
    details: Optional[str] = None
    cost: Optional[EvaluationCost] = None
    inputs: Optional[Dict[str, str]] = None

    def to_wire(self) -> Dict[str, Any]:
        """The camel case shape of ``results.evaluations`` on the run finished event."""
        wire: Dict[str, Any] = {
            "evaluatorId": self.evaluator_id,
            "name": self.name,
            "status": self.status,
            "required": self.required,
        }
        for key in ("passed", "score", "label", "details", "inputs"):
            value = getattr(self, key)
            if value is not None:
                wire[key] = value
        if self.cost is not None:
            wire["cost"] = {"currency": self.cost.currency, "amount": self.cost.amount}
        return wire


def _source(source_id: EvaluatorMappingSourceId, path: List[str]) -> EvaluatorMapping:
    return EvaluatorMapping(type="source", source_id=source_id, path=path)


class _Conversation:
    """Inputs that read the conversation of the run."""

    #: The first message the simulated user sent.
    first_user_message = _source("conversation", ["first_user_message"])
    #: The last message the agent under test sent.
    last_agent_message = _source("conversation", ["last_agent_message"])
    #: The whole conversation as ``role: content`` lines.
    transcript = _source("conversation", ["transcript"])
    #: The whole conversation as a JSON list of messages.
    messages = _source("conversation", ["messages"])


class _ScenarioSource:
    """Inputs that read the scenario definition."""

    #: The scenario description.
    situation = _source("scenario", ["situation"])
    #: The judge criteria, one per line.
    criteria = _source("scenario", ["criteria"])


class _Trace:
    """Inputs that read evidence from the trace of the run."""

    #: The contexts retrieved by the agent, concatenated.
    contexts = _source("trace", ["contexts"])

    @staticmethod
    def tool_call(name: str) -> ToolCallMapping:
        """
        The last call to a tool, for example ``trace.tool_call("run_sql").input``.
        A run without that call fails the evaluator with a reason.
        """
        return ToolCallMapping(
            input=_source("trace", ["tool_calls", name, "input"]),
            output=_source("trace", ["tool_calls", name, "output"]),
        )


conversation = _Conversation()
scenario_source = _ScenarioSource()
trace = _Trace()


def field(name: str) -> EvaluatorMapping:
    """
    An input that reads one field of the scenario, for example
    ``field("golden_sql")``. A scenario that leaves the field blank skips the
    evaluator with a reason.
    """
    return _source("scenario", ["fields", name])


def value(literal: str) -> EvaluatorMapping:
    """An input that takes a literal value."""
    return EvaluatorMapping(type="value", value=literal)


def evaluator(
    evaluator: str,
    *,
    required: Optional[bool] = None,
    mappings: Optional[Dict[str, EvaluatorMapping]] = None,
    settings: Optional[Dict[str, Any]] = None,
) -> ScenarioEvaluator:
    """
    Attaches a LangWatch evaluator to a scenario run.

    Args:
        evaluator: A built-in type such as ``ragas/sql_query_equivalence``, or
            a saved evaluator as ``evaluators/<slug>``.
        required: Whether a failing verdict fails the scenario. Defaults to
            True for an evaluator that answers pass or fail.
        mappings: Where each input reads from. Unmapped inputs are inferred
            from their names.
        settings: Per-run overrides of the evaluator settings.

    Example:
        ```
        scenario.evaluator(
            "ragas/sql_query_equivalence",
            required=True,
            mappings={
                "output": scenario.trace.tool_call("run_sql").input,
                "expected_output": scenario.field("golden_sql"),
            },
        )
        ```
    """
    if not evaluator:
        raise ValueError("An evaluator reference is required")
    return ScenarioEvaluator(
        evaluator=evaluator,
        required=required,
        mappings=dict(mappings or {}),
        settings=settings,
    )


__all__ = [
    "EvaluationCost",
    "EvaluationResult",
    "EvaluationStatus",
    "EvaluatorMapping",
    "ScenarioEvaluator",
    "ToolCallMapping",
    "conversation",
    "evaluator",
    "field",
    "scenario_source",
    "trace",
    "value",
]
