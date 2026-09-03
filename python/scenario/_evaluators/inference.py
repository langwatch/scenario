"""
Infers where an unmapped evaluator input reads from, by its name. Mirrors
the rules the LangWatch platform applies when an evaluator is attached to a
test suite, so a scenario in code and a scenario on the platform map the same
inputs the same way.

- ``input``, ``question``, ``user_input`` read the first user message
- ``output``, ``response``, ``answer`` read the last agent message
- ``transcript``, ``conversation``, ``messages`` read the transcript
- ``contexts``, ``retrieved_contexts`` read the retrieved contexts of the trace
- an expected-like input (``expected_*``, ``golden``, ``reference``,
  ``ground_truth``) reads the one field whose name shares a word with it
- a tool call is never inferred
"""

import re
from typing import Dict, List, Optional, Sequence

from scenario.evaluators import EvaluatorMapping, conversation, field, trace

_CONVERSATION_INPUTS: Dict[str, EvaluatorMapping] = {
    "input": conversation.first_user_message,
    "question": conversation.first_user_message,
    "user_input": conversation.first_user_message,
    "output": conversation.last_agent_message,
    "response": conversation.last_agent_message,
    "answer": conversation.last_agent_message,
    "transcript": conversation.transcript,
    "conversation": conversation.transcript,
    "messages": conversation.transcript,
    "contexts": trace.contexts,
    "retrieved_contexts": trace.contexts,
}

_EXPECTED_LIKE_PREFIXES = ("expected_", "golden", "reference", "ground_truth")

# The field name words each expected-like input accepts. An input not listed
# here accepts the words of its own name, "expected" removed.
_EXPECTED_INPUT_WORDS: Dict[str, List[str]] = {
    "expected_output": [
        "expected",
        "golden",
        "reference",
        "answer",
        "sql",
        "query",
        "label",
        "target",
    ],
    "expected_contexts": ["schema", "schemas", "context", "contexts", "table", "tables"],
}


def is_expected_like_input(input_id: str) -> bool:
    return input_id.lower().startswith(_EXPECTED_LIKE_PREFIXES)


def _words(identifier: str) -> List[str]:
    return [word for word in re.split(r"[^a-z0-9]+", identifier.lower()) if word]


def _infer_field(input_id: str, field_names: Sequence[str]) -> Optional[EvaluatorMapping]:
    if not field_names:
        return None
    if len(field_names) == 1:
        return field(field_names[0])
    accepted = set(
        _EXPECTED_INPUT_WORDS.get(input_id.lower())
        or [word for word in _words(input_id) if word != "expected"]
    )
    candidates = [
        name for name in field_names if any(word in accepted for word in _words(name))
    ]
    return field(candidates[0]) if len(candidates) == 1 else None


def infer_evaluator_mappings(
    *,
    inputs: Sequence[str],
    field_names: Sequence[str],
    mappings: Optional[Dict[str, EvaluatorMapping]] = None,
) -> Dict[str, EvaluatorMapping]:
    """
    Completes the mappings of an evaluator: explicit mappings stay as they
    are, every other input the evaluator declares is inferred from its name,
    and an input that cannot be inferred stays unmapped.
    """
    result: Dict[str, EvaluatorMapping] = dict(mappings or {})
    for input_id in inputs:
        if input_id in result:
            continue
        inferred = (
            _infer_field(input_id, field_names)
            if is_expected_like_input(input_id)
            else _CONVERSATION_INPUTS.get(input_id.lower())
        )
        if inferred is not None:
            result[input_id] = inferred
    return result
