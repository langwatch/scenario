"""
Re-sends a model call without a parameter the provider refused.

Providers refuse parameters that older models accepted, and the refusal names
the parameter:

- ``relax_tool_choice``: models that think before answering (Claude Opus 5.5
  on Bedrock, Anthropic models with thinking on) refuse a tool choice that
  forces a tool. The call is re-sent with tool choice ``auto`` and an
  instruction to answer through the tools.
- ``drop_temperature``: newer models refuse any temperature (Claude Sonnet 5)
  or any value but the default (GPT-5.5). The call is re-sent without it.
- ``reasoning_off``: some reasoning models refuse function tools on
  ``/v1/chat/completions`` unless reasoning is switched off (GPT-5.6,
  langwatch/scenario#864). The call is re-sent with ``reasoning_effort``
  ``none``.

Nothing is changed up front: whether a model accepts a parameter is not
knowable in advance, so the call goes out as configured and is adapted only
when the provider's refusal asks for exactly that. An adaptation is remembered
for the later calls of the same agent, so a model pays for the refusal once.
The JavaScript SDK recognises the same refusals; keep them in sync.
"""

import logging
import re
from typing import Any, Optional, Set, cast

import litellm
from litellm.files.main import ModelResponse


logger = logging.getLogger("scenario")

REASONING_OFF = "none"


def _forces_tool(tool_choice: Any) -> bool:
    if tool_choice == "required":
        return True
    return isinstance(tool_choice, dict) and tool_choice.get("type") in (
        "function",
        "tool",
    )


def adaptation_for(error: Exception, kwargs: dict) -> Optional[str]:
    """The adaptation a provider refusal asks for, or None for any other error."""
    text = str(error)
    if (
        _forces_tool(kwargs.get("tool_choice"))
        and re.search(r"tool_choice", text, re.IGNORECASE)
        and re.search(r"not supported|forces tool use", text, re.IGNORECASE)
    ):
        return "relax_tool_choice"
    if (
        kwargs.get("temperature") is not None
        and re.search(r"temperature", text, re.IGNORECASE)
        and re.search(
            r"deprecated|not support|unsupported|only the default",
            text,
            re.IGNORECASE,
        )
    ):
        return "drop_temperature"
    # Keyed on the remediation directive, not just the field name: an error
    # such as "reasoning_effort 'none' is invalid for this model" mentions
    # both tokens but is not asking for reasoning off. A caller that already
    # chose an effort keeps it and gets the provider's own error.
    if (
        kwargs.get("tools")
        and "reasoning_effort" not in kwargs
        and "set reasoning_effort to 'none'" in text
    ):
        return "reasoning_off"
    return None


def _tool_instruction(tool_choice: Any) -> str:
    if isinstance(tool_choice, dict):
        name = (tool_choice.get("function") or {}).get("name") or tool_choice.get(
            "name"
        )
        if name:
            return f"Answer only by calling the {name} tool, never with plain text."
    return "Answer only by calling one of the provided tools, never with plain text."


def apply_adaptations(kwargs: dict, adaptations: Set[str]) -> dict:
    """The call arguments with the adaptations learned so far applied."""
    adapted = dict(kwargs)
    if "drop_temperature" in adaptations:
        adapted.pop("temperature", None)
    if "relax_tool_choice" in adaptations and _forces_tool(adapted.get("tool_choice")):
        instruction = {
            "role": "user",
            "content": _tool_instruction(adapted["tool_choice"]),
        }
        adapted["tool_choice"] = "auto"
        adapted["messages"] = [*adapted.get("messages", []), instruction]
    if (
        "reasoning_off" in adaptations
        and adapted.get("tools")
        and "reasoning_effort" not in adapted
    ):
        adapted["reasoning_effort"] = REASONING_OFF
    return adapted


class ProviderCompat:
    """Calls ``litellm.completion``, adapting to the refusals seen so far."""

    def __init__(self) -> None:
        self._adaptations: Set[str] = set()

    def completion(self, **kwargs: Any) -> ModelResponse:
        while True:
            adapted = apply_adaptations(kwargs, self._adaptations)
            try:
                return cast(ModelResponse, litellm.completion(**adapted))
            except Exception as error:
                adaptation = adaptation_for(error, adapted)
                if adaptation is None or adaptation in self._adaptations:
                    raise
                logger.debug(
                    "provider refused the call to %s, retrying with %s",
                    kwargs.get("model"),
                    adaptation,
                )
                self._adaptations.add(adaptation)
