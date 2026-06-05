import httpx
import json
import pytest
import respx
import logging
import time
from typing import Generator
from _pytest.logging import LogCaptureFixture
from scenario._events.event_reporter import EventReporter
from scenario._events.events import (
    ScenarioRunStartedEvent,
    ScenarioRunStartedEventMetadata,
)


def _make_event() -> ScenarioRunStartedEvent:
    metadata = ScenarioRunStartedEventMetadata(
        name="test-name",
        description="test-description",
    )
    return ScenarioRunStartedEvent(
        batch_run_id="batch-1",
        scenario_id="scenario-1",
        scenario_run_id="run-1",
        metadata=metadata,
        timestamp=int(time.time() * 1000),
    )


@pytest.fixture(autouse=True)
def _reset_warned_state() -> None:
    """Reset the EventReporter warn-once flag between tests."""
    EventReporter._missing_api_key_warned = False


@pytest.fixture
def _reset_langwatch_client_state() -> Generator[None, None, None]:
    """Avoid cross-test contamination of the langwatch SDK class-level api_key."""
    try:
        from langwatch.client import Client

        previous = Client._api_key
        Client._api_key = ""
        yield
        Client._api_key = previous
    except Exception:
        yield


@pytest.mark.asyncio
async def test_post_event_sends_correct_request(caplog: LogCaptureFixture) -> None:
    endpoint = "https://app.langwatch.ai"
    api_key = "test-api-key"
    event = _make_event()

    reporter = EventReporter(endpoint=endpoint, api_key=api_key)

    with respx.mock as mock:
        route = mock.post(f"{endpoint}/api/scenario-events").respond(
            200, json={"ok": True}
        )
        with caplog.at_level(logging.DEBUG):
            await reporter.post_event(event)

        assert route.called
        request: httpx.Request = route.calls[0].request
        assert request.headers["Authorization"] == f"Bearer {api_key}"
        assert "X-Auth-Token" not in request.headers
        assert request.headers["Content-Type"] == "application/json"
        # Without project_id, no X-Project-Id header is sent — the API key is
        # assumed to be project-bound.
        assert "X-Project-Id" not in request.headers
        assert (
            b'"type": "SCENARIO_RUN_STARTED"' in request.content
            or b'"type":"SCENARIO_RUN_STARTED"' in request.content
        )
        assert any("POST response status: 200" in m for m in caplog.messages)


@pytest.mark.asyncio
async def test_post_event_includes_x_project_id_when_configured() -> None:
    """When project_id is set, X-Project-Id is sent alongside Authorization.

    This supports API keys that are not bound to a single project — the
    project_id tells the server which project to scope the request to.
    """
    endpoint = "https://app.langwatch.ai"
    api_key = "test-api-key"
    project_id = "project_xxx"
    event = _make_event()

    reporter = EventReporter(
        endpoint=endpoint, api_key=api_key, project_id=project_id
    )

    with respx.mock as mock:
        route = mock.post(f"{endpoint}/api/scenario-events").respond(
            200, json={"ok": True}
        )
        await reporter.post_event(event)

        assert route.called
        request: httpx.Request = route.calls[0].request
        assert request.headers["Authorization"] == f"Bearer {api_key}"
        assert request.headers["X-Project-Id"] == project_id


@pytest.mark.asyncio
async def test_project_id_falls_back_to_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LANGWATCH_PROJECT_ID", "project_from_env")

    reporter = EventReporter(
        endpoint="https://app.langwatch.ai", api_key="test-api-key"
    )
    event = _make_event()

    with respx.mock as mock:
        route = mock.post("https://app.langwatch.ai/api/scenario-events").respond(
            200, json={"ok": True}
        )
        await reporter.post_event(event)

        assert route.called
        request: httpx.Request = route.calls[0].request
        assert request.headers["X-Project-Id"] == "project_from_env"


@pytest.mark.asyncio
async def test_explicit_project_id_wins_over_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LANGWATCH_PROJECT_ID", "project_from_env")

    reporter = EventReporter(
        endpoint="https://app.langwatch.ai",
        api_key="test-api-key",
        project_id="project_explicit",
    )
    event = _make_event()

    with respx.mock as mock:
        route = mock.post("https://app.langwatch.ai/api/scenario-events").respond(
            200, json={"ok": True}
        )
        await reporter.post_event(event)

        assert route.called
        request: httpx.Request = route.calls[0].request
        assert request.headers["X-Project-Id"] == "project_explicit"


@pytest.mark.asyncio
async def test_inherits_api_key_from_langwatch_setup(
    monkeypatch: pytest.MonkeyPatch,
    _reset_langwatch_client_state: None,
) -> None:
    """Customer calls langwatch.setup(api_key=...) without setting env var.

    The langwatch SDK stores api_key on `Client._api_key`. EventReporter must fall
    back to that state when its own env var is empty, so OTel and scenario-events
    use the same credential without the user having to set LANGWATCH_API_KEY twice.
    """
    monkeypatch.delenv("LANGWATCH_API_KEY", raising=False)

    from langwatch.client import Client

    Client._api_key = "sk-lw-from-langwatch-setup"

    reporter = EventReporter(endpoint="https://app.langwatch.ai")
    event = _make_event()

    with respx.mock as mock:
        route = mock.post("https://app.langwatch.ai/api/scenario-events").respond(
            200, json={"ok": True}
        )
        await reporter.post_event(event)

        assert route.called
        request: httpx.Request = route.calls[0].request
        assert request.headers["Authorization"] == "Bearer sk-lw-from-langwatch-setup"


@pytest.mark.asyncio
async def test_constructor_api_key_wins_over_env_and_langwatch_state(
    monkeypatch: pytest.MonkeyPatch,
    _reset_langwatch_client_state: None,
) -> None:
    monkeypatch.setenv("LANGWATCH_API_KEY", "sk-lw-from-env")

    from langwatch.client import Client

    Client._api_key = "sk-lw-from-langwatch"

    reporter = EventReporter(
        endpoint="https://app.langwatch.ai",
        api_key="sk-lw-explicit",
    )
    event = _make_event()

    with respx.mock as mock:
        route = mock.post("https://app.langwatch.ai/api/scenario-events").respond(
            200, json={"ok": True}
        )
        await reporter.post_event(event)

        assert route.called
        request: httpx.Request = route.calls[0].request
        assert request.headers["Authorization"] == "Bearer sk-lw-explicit"


@pytest.mark.asyncio
async def test_env_var_wins_over_langwatch_state_when_no_explicit_key(
    monkeypatch: pytest.MonkeyPatch,
    _reset_langwatch_client_state: None,
) -> None:
    monkeypatch.setenv("LANGWATCH_API_KEY", "sk-lw-from-env")

    from langwatch.client import Client

    Client._api_key = "sk-lw-from-langwatch"

    reporter = EventReporter(endpoint="https://app.langwatch.ai")
    event = _make_event()

    with respx.mock as mock:
        route = mock.post("https://app.langwatch.ai/api/scenario-events").respond(
            200, json={"ok": True}
        )
        await reporter.post_event(event)

        assert route.called
        request: httpx.Request = route.calls[0].request
        assert request.headers["Authorization"] == "Bearer sk-lw-from-env"


@pytest.mark.asyncio
async def test_skips_post_when_api_key_unavailable_everywhere(
    caplog: LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
    _reset_langwatch_client_state: None,
) -> None:
    """When no api_key is set anywhere, never POST. Customer ran into hundreds of
    thousands of 401s/day because an empty bearer token was still being sent
    on every event. Skipping silently is correct — the greeting message in
    EventAlertMessageLogger already directs the user to set LANGWATCH_API_KEY.
    """
    monkeypatch.delenv("LANGWATCH_API_KEY", raising=False)

    reporter = EventReporter(endpoint="https://app.langwatch.ai")
    event = _make_event()

    with respx.mock as mock:
        route = mock.post("https://app.langwatch.ai/api/scenario-events").respond(
            200, json={"ok": True}
        )
        with caplog.at_level(logging.DEBUG):
            result = await reporter.post_event(event)

        assert not route.called
        assert result == {}
        # No ERROR-level lines emitted for the skip
        error_records = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert error_records == []


@pytest.mark.asyncio
async def test_warns_only_once_when_api_key_missing(
    caplog: LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
    _reset_langwatch_client_state: None,
) -> None:
    """Multiple events in the same process must not produce multiple warnings."""
    monkeypatch.delenv("LANGWATCH_API_KEY", raising=False)

    reporter = EventReporter(endpoint="https://app.langwatch.ai")

    with respx.mock as mock:
        mock.post("https://app.langwatch.ai/api/scenario-events").respond(200, json={"ok": True})
        with caplog.at_level(logging.WARNING):
            for _ in range(10):
                await reporter.post_event(_make_event())

    matching = [
        r for r in caplog.records
        if "LANGWATCH_API_KEY" in r.getMessage() and r.levelno == logging.WARNING
    ]
    assert len(matching) == 1, (
        f"Expected exactly one warning across 10 events, got {len(matching)}: "
        f"{[r.getMessage() for r in matching]}"
    )


@pytest.mark.asyncio
async def test_post_event_failure_log_redacts_base64_audio(
    caplog: LogCaptureFixture,
    monkeypatch,
) -> None:
    """Failed POST log must not dump raw base64 WAV payloads."""
    from scenario._events.events import ScenarioMessageSnapshotEvent

    big_b64 = "U" * 5000
    messages = [
        {
            "id": "msg-1",
            "role": "user",
            "content": [
                {"type": "text", "text": "hello"},
                {
                    "type": "input_audio",
                    "input_audio": {"data": big_b64, "format": "wav"},
                },
            ],
        }
    ]
    event = ScenarioMessageSnapshotEvent(
        batch_run_id="batch-1",
        scenario_id="scenario-1",
        scenario_run_id="run-1",
        messages=messages,  # type: ignore[arg-type]
        timestamp=int(time.time() * 1000),
    )

    monkeypatch.setenv("LANGWATCH_ENDPOINT", "https://example.test")
    monkeypatch.setenv("LANGWATCH_API_KEY", "sk-test")
    reporter = EventReporter()

    with respx.mock:
        respx.post("https://example.test/api/scenario-events").mock(
            return_value=httpx.Response(500, text="boom")
        )
        with caplog.at_level(logging.ERROR):
            await reporter.post_event(event)

    joined = "\n".join(r.getMessage() for r in caplog.records)
    # Either path (failed POST or in-flight exception) must scrub the payload.
    assert "Event POST" in joined
    assert big_b64 not in joined
    assert "<audio:" in joined


def test_redacted_event_repr_scrubs_b64_inside_stringified_content() -> None:
    """The wire format sometimes carries content as a repr() string. Scrub that too."""
    from scenario._events.event_reporter import _redacted_event_repr

    big_b64 = "U" * 5000

    class _FakeEvent:
        def to_dict(self) -> dict:
            return {
                "type": "SCENARIO_MESSAGE_SNAPSHOT",
                "messages": [
                    {
                        "id": "scenariomsg_1",
                        "role": "assistant",
                        "content": (
                            "[{'type': 'input_audio', 'input_audio': "
                            f"{{'data': '{big_b64}', 'format': 'wav'}}}}]"
                        ),
                    }
                ],
            }

    rendered = _redacted_event_repr(_FakeEvent())

    assert big_b64 not in rendered
    assert "<audio:" in rendered


@pytest.mark.asyncio
async def test_message_snapshot_post_carries_tool_call_structured_not_flattened(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AC3a (#630): a realtime tool-call message must round-trip into the
    outbound SCENARIO_MESSAGE_SNAPSHOT POST as
    ``messages[].tool_calls[].function.{name,arguments}`` — structured, not a
    text-flattened marker baked into ``content``.

    The #630 adapter fix now emits the realtime tool call as an OpenAI-shaped
    assistant message with ``tool_calls`` (content ``None``). This test drives
    that raw shape through the REAL persistence mapper
    (``convert_messages_to_api_client_messages``) into a
    ``ScenarioMessageSnapshotEvent`` and POSTs it via ``EventReporter`` with a
    mocked HTTP layer, then asserts on the serialized wire body. We feed the raw
    OpenAI dict (NOT a hand-built ``ToolCall``) so the test proves the mapper
    itself handles the realtime tool-call shape.
    """
    from scenario._events.events import ScenarioMessageSnapshotEvent
    from scenario._events.utils import convert_messages_to_api_client_messages

    expected_args = {"x": 1}
    # Raw OpenAI-shaped assistant message, exactly as the #630 realtime adapter
    # fix produces it: content is None, the tool call lives under `tool_calls`.
    raw_messages = [
        {
            "id": "msg-tool-1",
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "c1",
                    "type": "function",
                    "function": {
                        "name": "T",
                        "arguments": json.dumps(expected_args),
                    },
                }
            ],
        }
    ]

    # (a) Exercise the REAL mapper and assert it produced a structured ToolCall.
    api_messages = convert_messages_to_api_client_messages(raw_messages)  # type: ignore[arg-type]
    assert len(api_messages) == 1
    mapped = api_messages[0]
    assert mapped.tool_calls is not None  # type: ignore[union-attr]
    assert mapped.tool_calls[0].function.name == "T"  # type: ignore[union-attr]
    assert json.loads(mapped.tool_calls[0].function.arguments) == expected_args  # type: ignore[union-attr]

    event = ScenarioMessageSnapshotEvent(
        batch_run_id="batch-1",
        scenario_id="scenario-1",
        scenario_run_id="run-1",
        messages=api_messages,
        timestamp=int(time.time() * 1000),
    )

    monkeypatch.setenv("LANGWATCH_ENDPOINT", "https://app.langwatch.ai")
    monkeypatch.setenv("LANGWATCH_API_KEY", "sk-test")
    reporter = EventReporter()

    with respx.mock as mock:
        route = mock.post("https://app.langwatch.ai/api/scenario-events").respond(
            200, json={"ok": True}
        )
        await reporter.post_event(event)

        assert route.called
        # (b) Assert on the actual serialized POST body that goes over the wire.
        request: httpx.Request = route.calls[0].request
        body = json.loads(request.content)
        assert body["type"] == "SCENARIO_MESSAGE_SNAPSHOT"

        posted_message = body["messages"][0]
        # The generated API model serializes tool calls under the camelCase
        # `toolCalls` wire key (see PostApiScenarioEventsBodyType2MessagesItemType2.to_dict).
        tool_calls = posted_message["toolCalls"]
        assert tool_calls[0]["type"] == "function"
        assert tool_calls[0]["function"]["name"] == "T"
        assert json.loads(tool_calls[0]["function"]["arguments"]) == expected_args

        # NOT text-flattened: the tool call is structured under `toolCalls`, and
        # no marker string for it leaks into `content`.
        content = posted_message.get("content")
        assert content in (None, "")
        if isinstance(content, str):
            assert "T" not in content
            assert "tool" not in content.lower()
        # Defensive: the literal arguments payload must not appear flattened in
        # the serialized content of any posted message.
        for message in body["messages"]:
            assert json.dumps(expected_args) != message.get("content")
