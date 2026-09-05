"""
Attach LangWatch evaluators to scenario runs: the mapping helpers, the
evaluator attachment and the result one evaluator produces.

A mapping is a function of the scenario state, the same ``ScenarioState`` a
script step receives, sync or async, or a literal for a constant. The helpers
in this module are that same kind of function with a name: each one carries
the state expression it stands for.

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
                    "output": lambda state: state.tool_calls("run_sql").last.input,
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

from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

if TYPE_CHECKING:
    from scenario.scenario_state import ScenarioState

EvaluationStatus = Literal["passed", "failed", "scored", "skipped", "error"]

#: A literal an evaluator input takes as a constant.
EvaluatorMappingLiteral = Union[str, int, float, bool]

#: Where one evaluator input reads its value from: a function of the scenario
#: state, sync or async, or a literal. Returning ``None`` or an empty list
#: skips the evaluator; raising reports an error result.
EvaluatorMapping = Union[
    Callable[["ScenarioState"], Any],
    Callable[["ScenarioState"], Awaitable[Any]],
    EvaluatorMappingLiteral,
]


class StateMapping:
    """
    A mapping helper: a function of the state that names its expression.

    Attributes:
        expression: The state expression the helper stands for, for example
            ``state.field("golden_sql")``.
    """

    def __init__(self, expression: str, read: Callable[["ScenarioState"], Any]) -> None:
        self.expression = expression
        self._read = read
        self.__doc__ = expression

    def __call__(self, state: "ScenarioState") -> Any:
        return self._read(state)

    def __repr__(self) -> str:
        return f"<mapping {self.expression}>"


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
        mappings: Where each evaluator input reads from, keyed by input name:
            a function of the scenario state or a literal. An input without a
            mapping is inferred from its name; a tool call is never inferred.
        settings: Per-run overrides of the evaluator settings.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    evaluator: str
    required: Optional[bool] = None
    mappings: Dict[str, Any] = Field(default_factory=dict)
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
            "no run_sql call in the trace", "the mapping returned nothing",
            or the error.
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


class _Conversation:
    """Inputs that read the conversation of the run."""

    #: ``state.first_user_message() or None``: the text of the first message the simulated user sent.
    first_user_message = StateMapping(
        "state.first_user_message() or None", lambda state: state.first_user_message() or None
    )
    #: ``state.last_agent_message() or None``: the text of the last message the agent under test sent.
    last_agent_message = StateMapping(
        "state.last_agent_message() or None", lambda state: state.last_agent_message() or None
    )
    #: ``state.transcript()``: the whole conversation as ``role: content`` lines.
    transcript = StateMapping("state.transcript()", lambda state: state.transcript())
    #: ``state.messages``: the whole conversation as a list of messages.
    messages = StateMapping("state.messages", lambda state: list(state.messages))


class _ScenarioSource:
    """Inputs that read the scenario definition."""

    #: ``state.description``: the scenario description.
    situation = StateMapping("state.description", lambda state: state.description)
    #: ``"\\n".join(state.criteria)``: the judge criteria, one per line.
    criteria = StateMapping('"\\n".join(state.criteria)', lambda state: "\n".join(state.criteria))


class ToolCallPick:
    """The input and the output of one tool call pick."""

    def __init__(self, calls: str, pick: str, name: str) -> None:
        #: The arguments of the call.
        self.input = StateMapping(
            f"{calls}.{pick}.input", lambda state: getattr(state.tool_calls(name), pick).input
        )
        #: The result of the call.
        self.output = StateMapping(
            f"{calls}.{pick}.output", lambda state: getattr(state.tool_calls(name), pick).output
        )


class ToolCallsMapping:
    """
    The picks and columns over the calls of one tool.

    Attributes:
        first: ``state.tool_calls(name).first``, the first call of the tool.
        last: ``state.tool_calls(name).last``, the last call of the tool.
        inputs: ``state.tool_calls(name).inputs``, the arguments of every call.
        outputs: ``state.tool_calls(name).outputs``, the result of every call.
    """

    def __init__(self, name: str) -> None:
        calls = f"state.tool_calls({name!r})"
        self.first = ToolCallPick(calls, "first", name)
        self.last = ToolCallPick(calls, "last", name)
        self.inputs = StateMapping(f"{calls}.inputs", lambda state: state.tool_calls(name).inputs)
        self.outputs = StateMapping(f"{calls}.outputs", lambda state: state.tool_calls(name).outputs)


class _Trace:
    """Inputs that read evidence from the traces of the run."""

    #: ``state.contexts``: every chunk the agent retrieved, across the run.
    contexts = StateMapping("state.contexts", lambda state: state.contexts)
    #: ``state.spans``: every span of every trace of the run, in start order.
    spans = StateMapping("state.spans", lambda state: state.spans)

    @staticmethod
    def tool_calls(name: str) -> ToolCallsMapping:
        """
        ``state.tool_calls(name)``: the calls of one tool across the run, from
        the assistant messages and the tool spans.
        ``tool_calls("run_sql").last.input`` is the arguments of the last
        call; a run without that call skips the evaluator with the reason
        ``no run_sql call in the trace``.
        """
        return ToolCallsMapping(name)


conversation = _Conversation()
scenario_source = _ScenarioSource()
trace = _Trace()


def field(name: str) -> StateMapping:
    """
    ``state.field(name)``: one field of the scenario, for example
    ``field("golden_sql")``. A scenario that leaves the field blank skips the
    evaluator with the reason ``no golden_sql on this scenario``.
    """
    return StateMapping(f"state.field({name!r})", lambda state: state.field(name))


def value(literal: EvaluatorMappingLiteral) -> StateMapping:
    """
    An input that takes a literal value. A literal can also be written
    directly in the mappings; the helper is for symmetry with the others.
    """
    return StateMapping(repr(literal), lambda state: literal)


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
        mappings: Where each input reads from: a function of the scenario
            state or a literal. Unmapped inputs are inferred from their names.
        settings: Per-run overrides of the evaluator settings.

    Example:
        ```
        scenario.evaluator(
            "ragas/sql_query_equivalence",
            required=True,
            mappings={
                "output": lambda state: state.tool_calls("run_sql").last.input,
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
    "EvaluatorMappingLiteral",
    "ScenarioEvaluator",
    "StateMapping",
    "ToolCallPick",
    "ToolCallsMapping",
    "conversation",
    "evaluator",
    "field",
    "scenario_source",
    "trace",
    "value",
]
