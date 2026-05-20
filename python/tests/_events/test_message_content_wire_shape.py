"""
Tests proving that convert_messages_to_api_client_messages preserves structured
content (list[dict]) on the wire rather than mangling it into a Python-repr string
via str().

These tests MUST FAIL against the current implementation (which calls str(content)
at four call sites in _events/utils.py) and MUST PASS once str() is replaced with
pass-through logic that accepts Union[str, list].

See: https://github.com/langwatch/langwatch/issues/494
"""
import json
import time

import pytest
import respx

from scenario._events.event_reporter import EventReporter
from scenario._events.events import ScenarioMessageSnapshotEvent
from scenario._events.utils import convert_messages_to_api_client_messages

_ENDPOINT = "https://app.langwatch.ai"
_API_KEY = "test-api-key"
_EVENTS_URL = f"{_ENDPOINT}/api/scenario-events"


@pytest.fixture(autouse=True)
def _reset_warned_state() -> None:
    """Reset the EventReporter warn-once flag between tests."""
    EventReporter._missing_api_key_warned = False


def _make_snapshot_event(messages: list) -> ScenarioMessageSnapshotEvent:
    converted = convert_messages_to_api_client_messages(messages)
    return ScenarioMessageSnapshotEvent(
        batch_run_id="batch-1",
        scenario_id="scenario-1",
        scenario_run_id="run-1",
        messages=converted,
        timestamp=int(time.time() * 1000),
    )


@pytest.mark.asyncio
async def test_voice_input_audio_round_trips_as_json_array() -> None:
    """
    AC1 — voice input_audio content must arrive at the wire as a JSON array, not
    a Python-repr string.  The current str() call mangles
      [{"type": "input_audio", "input_audio": {"data": "QUJD", "format": "wav"}}]
    into the literal string
      "[{'type': 'input_audio', 'input_audio': {'data': 'QUJD', 'format': 'wav'}}]"
    which makes the server receive single-quoted keys and cannot be parsed as JSON.
    """
    audio_content = [
        {
            "type": "input_audio",
            "input_audio": {"data": "QUJD", "format": "wav"},
        }
    ]
    user_msg = {
        "role": "user",
        "id": "msg-1",
        "content": audio_content,
    }
    event = _make_snapshot_event([user_msg])
    reporter = EventReporter(endpoint=_ENDPOINT, api_key=_API_KEY)

    with respx.mock as mock:
        route = mock.post(_EVENTS_URL).respond(200, json={"ok": True})
        await reporter.post_event(event)

    assert route.called, "Expected POST to be sent"
    body = json.loads(route.calls[0].request.content)

    msg_content = body["messages"][0]["content"]
    # Must be a JSON array (Python list), not a string
    assert isinstance(msg_content, list), (
        f"Expected content to be a list but got {type(msg_content).__name__!r}: {msg_content!r}"
    )
    assert msg_content[0]["type"] == "input_audio"
    assert msg_content[0]["input_audio"]["data"] == "QUJD"
    assert msg_content[0]["input_audio"]["format"] == "wav"

    # The raw bytes must NOT contain single-quoted Python repr keys
    raw_bytes = route.calls[0].request.content
    assert b"'type':" not in raw_bytes, (
        "Wire payload contains Python-repr single-quoted keys — str() was applied to content"
    )


@pytest.mark.asyncio
async def test_text_only_content_round_trips_as_json_string() -> None:
    """
    AC2 — plain text content ("hello") must remain a JSON string on the wire.
    Regression guard: the fix must not break the common text-only path.
    """
    user_msg = {
        "role": "user",
        "id": "msg-2",
        "content": "hello",
    }
    event = _make_snapshot_event([user_msg])
    reporter = EventReporter(endpoint=_ENDPOINT, api_key=_API_KEY)

    with respx.mock as mock:
        route = mock.post(_EVENTS_URL).respond(200, json={"ok": True})
        await reporter.post_event(event)

    assert route.called
    body = json.loads(route.calls[0].request.content)

    msg_content = body["messages"][0]["content"]
    assert msg_content == "hello", (
        f"Expected content to be the string 'hello' but got: {msg_content!r}"
    )
    assert not isinstance(msg_content, list), (
        "Plain-text content must not be wrapped in a list"
    )


@pytest.mark.asyncio
async def test_mixed_multimodal_content_round_trips_intact() -> None:
    """
    AC3 — messages containing both text and audio parts must preserve order and
    structure for every element in the list.
    """
    mixed_content = [
        {"type": "text", "text": "describe this"},
        {
            "type": "input_audio",
            "input_audio": {"data": "QUJD", "format": "wav"},
        },
    ]
    user_msg = {
        "role": "user",
        "id": "msg-3",
        "content": mixed_content,
    }
    event = _make_snapshot_event([user_msg])
    reporter = EventReporter(endpoint=_ENDPOINT, api_key=_API_KEY)

    with respx.mock as mock:
        route = mock.post(_EVENTS_URL).respond(200, json={"ok": True})
        await reporter.post_event(event)

    assert route.called
    body = json.loads(route.calls[0].request.content)

    msg_content = body["messages"][0]["content"]
    assert isinstance(msg_content, list), (
        f"Expected a list of content parts, got {type(msg_content).__name__!r}"
    )
    assert len(msg_content) == 2, (
        f"Expected 2 content parts, got {len(msg_content)}"
    )
    assert msg_content[0] == {"type": "text", "text": "describe this"}
    assert msg_content[1]["type"] == "input_audio"
    assert msg_content[1]["input_audio"]["format"] == "wav"


@pytest.mark.parametrize(
    "role,extra",
    [
        ("user", {}),
        ("assistant", {}),
        ("system", {}),
        ("tool", {"tool_call_id": "tc-1"}),
    ],
)
def test_all_four_role_branches_preserve_list_content(
    role: str, extra: dict
) -> None:
    """
    Integration guard — all four role branches in convert_messages_to_api_client_messages
    must pass list content through without stringification.

    Tests the in-memory model object directly (no HTTP round-trip needed) because
    the bug is in the assignment, not just serialization.
    """
    list_content = [{"type": "text", "text": "x"}]
    msg = {"role": role, "id": "msg-4", "content": list_content, **extra}

    result = convert_messages_to_api_client_messages([msg])

    assert len(result) == 1, f"Expected 1 converted message for role={role!r}"
    actual_content = result[0].content
    assert isinstance(actual_content, list), (
        f"role={role!r}: expected content to be a list but got "
        f"{type(actual_content).__name__!r}: {actual_content!r}"
    )
    assert actual_content == list_content, (
        f"role={role!r}: content was mutated. "
        f"Expected {list_content!r}, got {actual_content!r}"
    )
