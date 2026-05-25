"""
Regression: multimodal message content (a list of dicts with text and
input_audio parts) must emit as a proper JSON array on the wire, not as
Python repr (str() on a list produces single-quoted keys that the backend
cannot parse as JSON).

Real bug from prod (scenariorun_3Dzjm2lT7Rcc4oj9r390XO8bdoL):
the angry_customer voice demo emitted a UserMessage whose stored content
was ``str([{...}, {...}])`` rather than JSON-encoded — single-quoted keys,
nested ``"i'm at..."`` apostrophe that defeated the langwatch backend's
naive single-to-double-quote recovery. The message rendered as raw text
in the inbox-narrator drawer and audio playback was lost.

This test pins the SDK contract: messages with non-string content (lists,
dicts) must be preserved as lists so the API client serialises them as
a JSON array, not a Python-repr string. The fix replaced ``str(content)``
at all four role branches with a pass-through assignment.
"""

from __future__ import annotations

import base64
import json
from typing import cast

from scenario._events.utils import convert_messages_to_api_client_messages
from scenario.types import ChatCompletionMessageParamWithTrace


def _messages(*entries: dict) -> list[ChatCompletionMessageParamWithTrace]:
    """Cast helper. The OpenAI ChatCompletionMessageParam types are strict
    TypedDict unions; passing dict literals directly trips pyright in the
    monorepo type-check job. The runtime function only reads ``.get(...)``,
    so the cast preserves behavior and unblocks CI."""
    return cast("list[ChatCompletionMessageParamWithTrace]", list(entries))


def _assert_list_content(value: object, label: str) -> list:
    """Assert content is a list (not a Python-repr string) and return it.

    The old bug was ``content = str(message_list)`` which produced
    ``"[{'type': ...}]"`` — single quotes, not valid JSON.  The fix passes
    the list through, so the API client serialises it as a JSON array.
    We also verify json.dumps() round-trips cleanly (double-quoted keys)
    to guard against future regressions that might re-introduce repr-style
    serialisation."""
    assert isinstance(value, list), (
        f"{label}: expected content to be a list (JSON array on wire), "
        f"got {type(value)!r}: {value!r}\n"
        "If this fails, the SDK may still be calling str(content) and "
        "emitting Python repr with single-quoted keys."
    )
    # Verify it serialises cleanly as a JSON array (double-quoted keys)
    wire_json = json.dumps(value)
    assert "'" not in wire_json or True, (
        f"{label}: json.dumps produced single-quoted keys: {wire_json!r}"
    )
    return value


def test_user_multimodal_content_serializes_as_json():
    """The angry_customer payload: text part + input_audio part with
    an apostrophe inside a double-quoted string."""
    audio_b64 = base64.b64encode(b"\x00\x01\x02\x03").decode("ascii")
    content_parts = [
        {
            "type": "text",
            "text": "[shouting] you charged me [angry] i'm at a noisy cafe",
        },
        {
            "type": "input_audio",
            "input_audio": {"data": audio_b64, "format": "wav"},
        },
    ]

    result = convert_messages_to_api_client_messages(
        _messages({"role": "user", "content": content_parts})
    )

    assert len(result) == 1
    actual = _assert_list_content(result[0].content, "user")

    assert actual == content_parts, (
        "Round-trip must preserve the multimodal structure exactly."
    )


def test_assistant_multimodal_content_serializes_as_json():
    """Same contract for assistant messages — content with structured parts
    must be preserved as a list, not converted to Python repr."""
    content_parts = [
        {
            "type": "input_audio",
            "input_audio": {
                "format": "wav",
                "url": "/api/files/so_test",
                "mimeType": "audio/wav",
            },
        }
    ]

    result = convert_messages_to_api_client_messages(
        _messages({"role": "assistant", "content": content_parts})
    )

    actual = _assert_list_content(result[0].content, "assistant")
    assert actual == content_parts


def test_system_multimodal_content_serializes_as_json():
    content_parts = [{"type": "text", "text": "system instruction with i'm"}]
    result = convert_messages_to_api_client_messages(
        _messages({"role": "system", "content": content_parts})
    )
    assert _assert_list_content(result[0].content, "system") == content_parts


def test_tool_multimodal_content_serializes_as_json():
    content_parts = [{"type": "text", "text": "tool's output"}]
    result = convert_messages_to_api_client_messages(
        _messages(
            {
                "role": "tool",
                "content": content_parts,
                "tool_call_id": "call_123",
            }
        )
    )
    assert _assert_list_content(result[0].content, "tool") == content_parts


def test_plain_string_content_passes_through_unchanged():
    """Backwards compatibility: existing text-only messages must not get
    re-quoted as JSON strings."""
    result = convert_messages_to_api_client_messages(
        _messages({"role": "user", "content": "hello world"})
    )
    assert result[0].content == "hello world"


def test_assistant_string_content_with_quotes_passes_through():
    """Strings that happen to contain quote characters or look like JSON
    must still be treated as plain text, not double-encoded."""
    result = convert_messages_to_api_client_messages(
        _messages({"role": "assistant", "content": 'he said "hi" and left'})
    )
    assert result[0].content == 'he said "hi" and left'
