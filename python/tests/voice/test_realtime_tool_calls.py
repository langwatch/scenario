"""
Issue #630 — realtime tool-call surfacing for OpenAIRealtimeAgentAdapter.

The Realtime API emits function-call (tool-call) events
(``response.function_call_arguments.delta``/``.done`` and the
``response.output_item.added``/``.done`` function_call item form). Before this
fix those events fell into recv_audio's terminal ``else`` and were logged-and-
dropped — never reaching ``result.messages``. This module proves they now land
as the documented OpenAI-chat shape: an assistant message with
``tool_calls:[{id, type:"function", function:{name, arguments}}]`` that
``state.has_tool_call`` / ``state.last_tool_call`` consume.

Mock strategy (same as test_realtime_agent_echo_safe.py): the Realtime
WebSocket is replaced by a queue-based mock (``_MockWS``) so no real API
connection is needed. Two test surfaces:

- Direct ``adapter.call(...)`` over ``_MockWS`` — exercises recv_audio's new
  function-call branches + the overridden call() in isolation (AC1, AC6, AC7,
  AC8, AC10, AC11).
- A full ``scenario.arun`` over ``_MockWS`` with a callable script step that
  captures the live ``ScenarioState`` — exercises the real
  ``has_tool_call``/``last_tool_call`` consumer against integrated adapter
  output (AC2, AC9).
"""

from __future__ import annotations

import base64
import json
from typing import Any, List, Optional, Sequence

import pytest

import scenario
from scenario.config import ScenarioConfig
from scenario.scenario_state import ScenarioState
from scenario.voice.adapters.openai_realtime import OpenAIRealtimeAgentAdapter


# ---------------------------------------------------------------------------
# Helpers — reuse the audio/PCM + mock-WS shapes from the echo-safe test.
# ---------------------------------------------------------------------------


def _make_pcm(n_samples: int = 480) -> bytes:
    """Minimal silent PCM16 mono @ 24 kHz."""
    return b"\x00\x00" * n_samples


def _b64_pcm(n_samples: int = 480) -> str:
    return base64.b64encode(_make_pcm(n_samples)).decode()


class _MockWS:
    """Queue-backed WebSocket mock (mirrors test_realtime_agent_echo_safe).

    ``recv()`` pops pre-loaded JSON event strings in order; once exhausted it
    raises asyncio.TimeoutError (tail silence). ``send()`` is recorded.
    """

    def __init__(self, events: List[str]) -> None:
        self._events = list(events)
        self._idx = 0
        self.sent: List[Any] = []

    async def send(self, msg: Any) -> None:
        self.sent.append(msg)

    async def recv(self) -> str:
        import asyncio

        if self._idx >= len(self._events):
            await asyncio.sleep(0)
            raise asyncio.TimeoutError("mock WS: no more events")
        evt = self._events[self._idx]
        self._idx += 1
        return evt

    async def close(self) -> None:
        pass


def _audio_delta_events() -> List[str]:
    """A few audio deltas + transcript + response.done — a normal spoken turn.

    recv_audio only RETURNS on an audio delta, so every turn that goes through
    call()/drain needs at least one audio delta to terminate the drain loop.
    """
    chunk = _b64_pcm(480)
    return [
        json.dumps({"type": "response.created"}),
        json.dumps({"type": "response.output_audio.delta", "delta": chunk}),
        json.dumps({"type": "response.output_audio.delta", "delta": chunk}),
        json.dumps(
            {
                "type": "response.output_audio_transcript.done",
                "transcript": "Let me look that up for you.",
            }
        ),
        json.dumps({"type": "response.done"}),
    ]


def _function_call_streaming_events(
    call_id: str, name: str, arguments: str
) -> List[str]:
    """The streaming-args form of a function call: deltas → done.

    Splits ``arguments`` across two deltas to exercise accumulation, with the
    name arriving via the output_item.added shell (as the real wire does — the
    `.done` event typically omits `name`).
    """
    mid = len(arguments) // 2
    return [
        json.dumps(
            {
                "type": "response.output_item.added",
                "item": {
                    "type": "function_call",
                    "name": name,
                    "call_id": call_id,
                },
            }
        ),
        json.dumps(
            {
                "type": "response.function_call_arguments.delta",
                "call_id": call_id,
                "delta": arguments[:mid],
            }
        ),
        json.dumps(
            {
                "type": "response.function_call_arguments.delta",
                "call_id": call_id,
                "delta": arguments[mid:],
            }
        ),
        json.dumps(
            {
                "type": "response.function_call_arguments.done",
                "call_id": call_id,
                "arguments": arguments,
            }
        ),
    ]


def _function_call_item_events(
    call_id: str, name: str, arguments: str
) -> List[str]:
    """The output-item form: a single ``response.output_item.done`` carrying
    the full function_call (name + call_id + arguments)."""
    return [
        json.dumps(
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "function_call",
                    "name": name,
                    "call_id": call_id,
                    "arguments": arguments,
                },
            }
        ),
    ]


def _make_adapter(events: List[str]) -> OpenAIRealtimeAgentAdapter:
    """Build an adapter wired to a _MockWS pre-loaded with ``events``."""
    adapter = OpenAIRealtimeAgentAdapter(speaks_first=True)
    adapter._ws = _MockWS(events)
    return adapter


class _FakeInput:
    """Minimal AgentInput stand-in for direct adapter.call() tests.

    Carries no scenario_state, so _AdapterRecorder degrades to a no-op (per the
    established test-double seam in adapter.py). new_messages is empty so call()
    sends no user audio and goes straight to draining the agent response.
    """

    new_messages: List[Any] = []


def _tool_call_messages(messages: Sequence[Any]) -> List[dict]:
    """All assistant messages in ``messages`` that carry top-level tool_calls."""
    return [
        m
        for m in messages
        if isinstance(m, dict)
        and m.get("role") == "assistant"
        and "tool_calls" in m
    ]


def _all_tool_calls(messages: Sequence[Any]) -> List[dict]:
    """Flatten every tool_call across all assistant tool_calls messages."""
    out: List[dict] = []
    for m in _tool_call_messages(messages):
        out.extend(m["tool_calls"])
    return out


def _normalize(messages: Any) -> List[dict]:
    """call() may return one dict or a list of dicts — normalize to a list."""
    if isinstance(messages, list):
        return [m for m in messages if isinstance(m, dict)]
    if isinstance(messages, dict):
        return [messages]
    return []


# ---------------------------------------------------------------------------
# AC1 — tool call reaches result.messages (direct call() surface)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac1_tool_call_surfaced_via_dedicated_branch():
    """
    AC1: a realtime function call lands in the returned messages as
    {"role":"assistant","tool_calls":[{id,type:"function",
    function:{name,arguments}}]}, AND the function-call event was consumed by a
    DEDICATED branch (proven via the accumulator effect — _completed_tool_calls
    populated — not the terminal else, which would leave it empty).
    """
    events = (
        _audio_delta_events()
        + _function_call_streaming_events(
            "call_abc", "get_weather", '{"location":"Paris"}'
        )
    )
    adapter = _make_adapter(events)

    returned = _normalize(await adapter.call(_FakeInput()))  # type: ignore[arg-type]

    # The dedicated branch ran (its EFFECT: accumulator finalized).
    assert adapter._completed_tool_calls, (
        "function-call event hit the terminal else (dropped) — "
        "_completed_tool_calls is empty"
    )

    calls = _all_tool_calls(returned)
    assert len(calls) == 1, f"expected 1 tool_call, got {calls}"
    tc = calls[0]
    assert tc["type"] == "function"
    assert tc["id"] == "call_abc"
    assert tc["function"]["name"] == "get_weather"
    parsed = json.loads(tc["function"]["arguments"])  # must parse
    assert parsed == {"location": "Paris"}

    # PROVE THE SHAPE — print the actual assistant tool_calls message.
    msg = _tool_call_messages(returned)[0]
    print("\n[AC1] assistant tool_calls message:")
    print(json.dumps(msg, indent=2))


@pytest.mark.asyncio
async def test_ac1_item_only_form_surfaced():
    """
    AC1 (variant): a function call delivered ONLY via the output_item.done form
    (no streaming-args events) is still surfaced — the item path is a valid
    sole source of a call.
    """
    events = _audio_delta_events() + _function_call_item_events(
        "call_item", "search_db", '{"q":"langwatch"}'
    )
    adapter = _make_adapter(events)

    returned = _normalize(await adapter.call(_FakeInput()))  # type: ignore[arg-type]
    calls = _all_tool_calls(returned)
    assert len(calls) == 1
    assert calls[0]["function"]["name"] == "search_db"
    assert json.loads(calls[0]["function"]["arguments"]) == {"q": "langwatch"}


# ---------------------------------------------------------------------------
# AC2 — assertion API works (full scenario run, live ScenarioState)
# ---------------------------------------------------------------------------


@pytest.fixture()
def _configure_scenario(monkeypatch):
    """Minimal ScenarioConfig + hermetic floor (no network)."""
    monkeypatch.delenv("LANGWATCH_API_KEY", raising=False)
    monkeypatch.delenv("LANGWATCH_ENDPOINT", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "test-sk-not-a-real-key")
    try:
        from scenario._events.event_reporter import EventReporter

        async def _noop_post_event(self, event):
            return {}

        monkeypatch.setattr(EventReporter, "post_event", _noop_post_event)
    except ImportError:
        # EventReporter is optional — if it's not importable in this env there's
        # nothing to stub out (the scenario run just won't POST events). Safe to skip.
        pass
    prev = ScenarioConfig.default_config
    ScenarioConfig.default_config = ScenarioConfig(
        default_model="openai/gpt-4.1-mini",
        verbose=False,
    )
    yield
    ScenarioConfig.default_config = prev


def _wire_adapter(adapter: OpenAIRealtimeAgentAdapter, events: List[str]) -> None:
    """Bypass the real WS connect so a scenario run uses the mock."""
    mock_ws = _MockWS(events)

    async def _fake_connect():
        adapter._ws = mock_ws

    async def _fake_disconnect():
        adapter._ws = None

    adapter.connect = _fake_connect  # type: ignore[method-assign]
    adapter.disconnect = _fake_disconnect  # type: ignore[method-assign]


@pytest.mark.asyncio
async def test_ac2_has_tool_call_and_last_tool_call(_configure_scenario):
    """
    AC2: through a real scenario run, the live ScenarioState answers
    has_tool_call("T") True and last_tool_call("T")["function"]["arguments"]
    parses to the expected args. A callable script step captures the live state
    after the agent turn so the REAL consumer code runs against integrated
    adapter output (not a hand-built state).
    """
    events = _audio_delta_events() + _function_call_streaming_events(
        "call_w", "get_weather", '{"location":"Tokyo"}'
    )
    adapter = OpenAIRealtimeAgentAdapter(speaks_first=True)
    _wire_adapter(adapter, events)

    captured: dict[str, Optional[ScenarioState]] = {"state": None}

    def _capture_state(state: ScenarioState):
        captured["state"] = state

    result = await scenario.arun(
        name="ac2-tool-call-assertion",
        description="Agent calls a tool",
        agents=[adapter],
        script=[
            scenario.agent(),
            _capture_state,
            scenario.succeed("done"),
        ],
    )

    state = captured["state"]
    assert state is not None, "script callable did not capture state"

    # The real consumer methods.
    assert state.has_tool_call("get_weather") is True
    tc = state.last_tool_call("get_weather")
    assert tc is not None
    assert json.loads(tc["function"]["arguments"]) == {"location": "Tokyo"}

    # Also assert it is genuinely in result.messages (end-to-end).
    calls = _all_tool_calls(list(result.messages))
    assert any(c["function"]["name"] == "get_weather" for c in calls)

    print("\n[AC2] state.last_tool_call('get_weather'):")
    print(json.dumps(tc, indent=2))


# ---------------------------------------------------------------------------
# AC6 — idempotency: streaming-args .done AND output_item.done same call_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac6_dedup_same_call_id_one_tool_call():
    """
    AC6: feeding BOTH the streaming-args path (delta×N + .done) AND the
    output_item.done for the SAME call_id yields exactly ONE tool_call.
    """
    call_id = "call_dup"
    name = "lookup"
    args = '{"id":42}'
    events = (
        _audio_delta_events()
        + _function_call_streaming_events(call_id, name, args)
        + _function_call_item_events(call_id, name, args)
    )
    adapter = _make_adapter(events)

    returned = _normalize(await adapter.call(_FakeInput()))  # type: ignore[arg-type]
    calls = _all_tool_calls(returned)
    assert len(calls) == 1, f"AC6 dedup failed — got {len(calls)} calls: {calls}"
    assert calls[0]["id"] == call_id
    assert calls[0]["function"]["name"] == name
    assert json.loads(calls[0]["function"]["arguments"]) == {"id": 42}


# ---------------------------------------------------------------------------
# AC7 — malformed / partial degrades safely (two cases)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac7a_malformed_or_missing_arguments_no_raise():
    """
    AC7(a): a function-call event with non-JSON arguments → surfaced with the
    RAW string (no parse-and-reraise); a missing-arguments call → "{}". The
    audio turn still returns in both cases.
    """
    # call_1: malformed (non-JSON) arguments via the item form.
    # call_2: name only, NO arguments anywhere → must default to "{}".
    events = (
        _audio_delta_events()
        + _function_call_item_events("call_bad", "do_thing", "not json {{{")
        + [
            json.dumps(
                {
                    "type": "response.output_item.done",
                    "item": {
                        "type": "function_call",
                        "name": "no_args",
                        "call_id": "call_noargs",
                        # no "arguments" key
                    },
                }
            )
        ]
    )
    adapter = _make_adapter(events)

    # Must NOT raise; audio turn still returns.
    returned = _normalize(await adapter.call(_FakeInput()))  # type: ignore[arg-type]
    audio_msgs = [
        m for m in returned if m.get("role") == "assistant" and "content" in m
        and m.get("content") is not None
    ]
    assert audio_msgs, "audio turn did not return (AC7 degraded path broke it)"

    calls = {c["id"]: c for c in _all_tool_calls(returned)}
    # Malformed args passed through verbatim (raw string), not parsed.
    assert calls["call_bad"]["function"]["arguments"] == "not json {{{"
    with pytest.raises(json.JSONDecodeError):
        json.loads(calls["call_bad"]["function"]["arguments"])
    # Missing args → "{}".
    assert calls["call_noargs"]["function"]["arguments"] == "{}"
    assert json.loads(calls["call_noargs"]["function"]["arguments"]) == {}


@pytest.mark.asyncio
async def test_ac7b_done_with_no_call_id_skipped():
    """
    AC7(b): a `.done` with NO call_id is skipped (no message emitted), and the
    audio turn still returns. No raise.
    """
    events = _audio_delta_events() + [
        json.dumps(
            {
                "type": "response.function_call_arguments.done",
                # no call_id
                "arguments": '{"x":1}',
            }
        )
    ]
    adapter = _make_adapter(events)

    returned = _normalize(await adapter.call(_FakeInput()))  # type: ignore[arg-type]
    # No tool_calls emitted.
    assert not _all_tool_calls(returned), (
        "a call_id-less .done event should emit no tool_call"
    )
    # Audio turn still returned.
    assert any(
        m.get("role") == "assistant" and m.get("content") is not None
        for m in returned
    )


# ---------------------------------------------------------------------------
# AC8 — audio-only turns unchanged (regression)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac8_tool_free_turn_has_no_tool_calls_key():
    """
    AC8: a tool-free turn returns a SINGLE assistant message (a dict, not a
    list) with no tool_calls key — byte-shape unchanged from the base adapter.
    """
    adapter = _make_adapter(_audio_delta_events())
    returned = await adapter.call(_FakeInput())  # type: ignore[arg-type]

    # Base behaviour returns a single dict, not a list.
    assert isinstance(returned, dict), (
        f"tool-free turn should return a single dict, got {type(returned)}"
    )
    assert "tool_calls" not in returned, "tool-free turn leaked a tool_calls key"
    assert returned["role"] == "assistant"
    # No completed calls recorded.
    assert adapter._completed_tool_calls == []


# ---------------------------------------------------------------------------
# AC9 — tool-call turn coexists with spoken turn
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac9_audio_and_tool_call_coexist():
    """
    AC9: the model speaks AND calls a tool in one turn → BOTH an audio-bearing
    assistant message AND the tool_calls message are present.
    """
    events = _audio_delta_events() + _function_call_streaming_events(
        "call_co", "fetch", '{"k":"v"}'
    )
    adapter = _make_adapter(events)
    returned = _normalize(await adapter.call(_FakeInput()))  # type: ignore[arg-type]

    # An audio-bearing assistant message.
    audio_present = any(
        m.get("role") == "assistant"
        and isinstance(m.get("content"), list)
        and any(
            isinstance(p, dict) and p.get("type") == "input_audio"
            for p in m["content"]
        )
        for m in returned
    )
    assert audio_present, "no audio-bearing assistant message present"

    # The tool_calls message.
    calls = _all_tool_calls(returned)
    assert any(c["function"]["name"] == "fetch" for c in calls)


# ---------------------------------------------------------------------------
# AC10 — multiple distinct tool calls in one turn
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac10_multiple_distinct_tool_calls(_configure_scenario):
    """
    AC10: two distinct function calls (call_id A→T1, B→T2) in one response →
    BOTH surface; has_tool_call('T1') and has_tool_call('T2') both True.
    Distinct from AC6 (which is the SAME call_id arriving twice).
    """
    events = (
        _audio_delta_events()
        + _function_call_streaming_events("call_A", "get_weather", '{"city":"NYC"}')
        + _function_call_item_events("call_B", "get_time", '{"tz":"UTC"}')
    )
    adapter = OpenAIRealtimeAgentAdapter(speaks_first=True)
    _wire_adapter(adapter, events)

    captured: dict[str, Optional[ScenarioState]] = {"state": None}

    def _capture_state(state: ScenarioState):
        captured["state"] = state

    result = await scenario.arun(
        name="ac10-multi-tool",
        description="Agent calls two tools",
        agents=[adapter],
        script=[scenario.agent(), _capture_state, scenario.succeed("done")],
    )

    state = captured["state"]
    assert state is not None
    assert state.has_tool_call("get_weather") is True
    assert state.has_tool_call("get_time") is True
    weather_call = state.last_tool_call("get_weather")
    assert weather_call is not None
    assert json.loads(
        weather_call["function"]["arguments"]
    ) == {"city": "NYC"}
    time_call = state.last_tool_call("get_time")
    assert time_call is not None
    assert json.loads(
        time_call["function"]["arguments"]
    ) == {"tz": "UTC"}

    # Both present in result.messages too.
    names = {c["function"]["name"] for c in _all_tool_calls(list(result.messages))}
    assert {"get_weather", "get_time"} <= names


# ---------------------------------------------------------------------------
# AC11 — tool-RESULT round-trip is OUT of scope
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac11_no_tool_result_message_emitted():
    """
    AC11: the adapter surfaces ONLY the assistant tool_calls REQUEST. It does
    NOT fabricate a role:"tool" result message — executing the tool and feeding
    the result back is the caller's responsibility, out of the adapter's scope.
    """
    events = _audio_delta_events() + _function_call_streaming_events(
        "call_req", "lookup", '{"q":"x"}'
    )
    adapter = _make_adapter(events)
    returned = _normalize(await adapter.call(_FakeInput()))  # type: ignore[arg-type]

    # Assistant tool_calls request IS present.
    assert _all_tool_calls(returned), "expected an assistant tool_calls request"
    # NO role:"tool" message is emitted by the adapter.
    tool_role_msgs = [m for m in returned if m.get("role") == "tool"]
    assert not tool_role_msgs, (
        f"adapter emitted a role:'tool' result message (out of scope): "
        f"{tool_role_msgs}"
    )
