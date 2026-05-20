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

from scenario._events.utils import convert_messages_to_api_client_messages


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
        [{"role": "user", "content": content_parts}]
    )

    assert len(result) == 1
    serialized = result[0].content
    assert isinstance(serialized, str), "API client expects content as str"

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
        [{"role": "assistant", "content": content_parts}]
    )

    parsed = json.loads(result[0].content)
    assert parsed == content_parts


def test_system_multimodal_content_serializes_as_json():
    content_parts = [{"type": "text", "text": "system instruction with i'm"}]
    result = convert_messages_to_api_client_messages(
        [{"role": "system", "content": content_parts}]
    )
    assert json.loads(result[0].content) == content_parts


def test_tool_multimodal_content_serializes_as_json():
    content_parts = [{"type": "text", "text": "tool's output"}]
    result = convert_messages_to_api_client_messages(
        [
            {
                "role": "tool",
                "content": content_parts,
                "tool_call_id": "call_123",
            }
        ]
    )
    assert json.loads(result[0].content) == content_parts


def test_plain_string_content_passes_through_unchanged():
    """Backwards compatibility: existing text-only messages must not get
    re-quoted as JSON strings."""
    result = convert_messages_to_api_client_messages(
        [{"role": "user", "content": "hello world"}]
    )
    assert result[0].content == "hello world"


def test_assistant_string_content_with_quotes_passes_through():
    """Strings that happen to contain quote characters or look like JSON
    must still be treated as plain text, not double-encoded."""
    result = convert_messages_to_api_client_messages(
        [{"role": "assistant", "content": 'he said "hi" and left'}]
    )
    assert result[0].content == 'he said "hi" and left'
