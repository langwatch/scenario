"""
Regression: multimodal message content (a list of dicts with text and
input_audio parts) must serialize to valid JSON, not Python repr.

Real bug from prod (scenariorun_3Dzjm2lT7Rcc4oj9r390XO8bdoL):
the angry_customer voice demo emitted a UserMessage whose stored content
was ``str([{...}, {...}])`` rather than JSON-encoded — single-quoted keys,
nested ``"i'm at..."`` apostrophe that defeated the langwatch backend's
naive single-to-double-quote recovery. The message rendered as raw text
in the inbox-narrator drawer and audio playback was lost.

This test pins the SDK contract: messages with non-string content (lists,
dicts) must be JSON-encoded so the receiving service can parse them.
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


def _content_str(value: object) -> str:
    """Narrow the API client's ``str | Unset`` content union to ``str`` so
    callers can hand it to ``json.loads``. Fails loud if the SDK ever
    starts emitting Unset for converted messages."""
    assert isinstance(value, str), f"expected serialized content as str, got {type(value)!r}"
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
    serialized = _content_str(result[0].content)

    # Must be parseable as JSON. Python repr produces single quotes that
    # json.loads rejects.
    parsed = json.loads(serialized)

    assert parsed == content_parts, (
        "Round-trip via JSON must preserve the multimodal structure exactly. "
        "If this fails with a JSONDecodeError, the SDK is still using "
        "str(content) and emitting Python repr instead of JSON."
    )


def test_assistant_multimodal_content_serializes_as_json():
    """Same contract for assistant messages — content with structured parts
    must be JSON, not Python repr. Mirrors the user-message case above."""
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

    parsed = json.loads(_content_str(result[0].content))
    assert parsed == content_parts


def test_system_multimodal_content_serializes_as_json():
    content_parts = [{"type": "text", "text": "system instruction with i'm"}]
    result = convert_messages_to_api_client_messages(
        _messages({"role": "system", "content": content_parts})
    )
    assert json.loads(_content_str(result[0].content)) == content_parts


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
    assert json.loads(_content_str(result[0].content)) == content_parts


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


# ---------------------------------------------------------------------------
# AC2 regression tests — empty/falsy user + system content must not raise
# Ref: specs/empty-content-turn-snapshot.feature  AC2
# ---------------------------------------------------------------------------


def test_empty_user_content_empty_string_does_not_raise():
    """AC2 — specs/empty-content-turn-snapshot.feature: converter must not raise for user message with content ''."""
    result = convert_messages_to_api_client_messages(
        _messages({"role": "user", "content": ""})
    )
    assert len(result) == 1
    assert result[0].content == ""


def test_empty_user_content_none_does_not_raise():
    """AC2 — specs/empty-content-turn-snapshot.feature: converter must not raise for user message with content None."""
    result = convert_messages_to_api_client_messages(
        _messages({"role": "user", "content": None})
    )
    assert len(result) == 1
    assert result[0].content == ""


def test_empty_user_content_empty_list_does_not_raise():
    """AC2 — specs/empty-content-turn-snapshot.feature: converter must not raise for user message with content []; coerces via json.dumps to '[]'."""
    result = convert_messages_to_api_client_messages(
        _messages({"role": "user", "content": []})
    )
    assert len(result) == 1
    assert result[0].content == "[]"


def test_empty_system_content_empty_string_does_not_raise():
    """AC2 — specs/empty-content-turn-snapshot.feature: converter must not raise for system message with content ''."""
    result = convert_messages_to_api_client_messages(
        _messages({"role": "system", "content": ""})
    )
    assert len(result) == 1
    assert result[0].content == ""


def test_empty_system_content_none_does_not_raise():
    """AC2 — specs/empty-content-turn-snapshot.feature: converter must not raise for system message with content None."""
    result = convert_messages_to_api_client_messages(
        _messages({"role": "system", "content": None})
    )
    assert len(result) == 1
    assert result[0].content == ""


def test_empty_system_content_empty_list_does_not_raise():
    """AC2 — specs/empty-content-turn-snapshot.feature: converter must not raise for system message with content []; coerces via json.dumps to '[]'."""
    result = convert_messages_to_api_client_messages(
        _messages({"role": "system", "content": []})
    )
    assert len(result) == 1
    assert result[0].content == "[]"


def test_empty_content_all_roles_coerce_without_raising():
    """AC2 — specs/empty-content-turn-snapshot.feature: assistant+user+system all with content='' must all coerce to '' without raising."""
    result = convert_messages_to_api_client_messages(
        _messages(
            {"role": "assistant", "content": ""},
            {"role": "user", "content": ""},
            {"role": "system", "content": ""},
        )
    )
    assert len(result) == 3
    for msg in result:
        assert msg.content == ""


def test_non_empty_content_serializes_unchanged():
    """AC2 (no-regression guard) — specs/empty-content-turn-snapshot.feature: non-empty user/system/assistant/tool content must not be dropped or mangled."""
    result = convert_messages_to_api_client_messages(
        _messages(
            {"role": "user", "content": "hello"},
            {"role": "system", "content": "be helpful"},
            {"role": "assistant", "content": "of course"},
            {"role": "tool", "content": "result data", "tool_call_id": "call_abc"},
        )
    )
    assert len(result) == 4
    assert result[0].content == "hello"
    assert result[1].content == "be helpful"
    assert result[2].content == "of course"
    assert result[3].content == "result data"
