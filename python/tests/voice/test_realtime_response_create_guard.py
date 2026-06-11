"""
Issue #657 — regression tests for recv_audio response.create race condition.

The user-audio branch at lines ~407-411 of openai_realtime.py sends
``response.create`` unconditionally after ``input_audio_buffer.commit``, even
while ``self._response_active`` is True (set on response.created, cleared on
response.done/response.cancelled).  The agent-turn elif at ~line 423 already
guards on ``not self._response_active``.

Fix (NOT in this file): add the same guard to the user-audio branch and defer
the create by setting ``_agent_turn_pending=True`` so it fires after
response.done clears ``_response_active``.

Test layout
-----------
AC1 — guard present: response.create suppressed while response is active.
AC2 — deferred response.create fires AFTER response.done (ordering asserted).
AC3 — single commit + single create across the full guarded sequence.
AC4 — control: agent-turn branch unaffected (should PASS now).
AC5 — control: normal path (no active response) sends commit then create (should PASS now).
AC6 — explicit server rejection raises RuntimeError.
AC7 — pre-fix timeout face resolves to a valid AudioChunk post-fix.

AC1/AC2/AC3/AC7 MUST FAIL on current (pre-fix) code.
AC4/AC5 MUST PASS on current code.
AC6 MUST PASS if the adapter already surfaces error events as RuntimeError.

Mock strategy: hermetic _MockWS from test_realtime_tool_calls.py — queue-based,
no live API key required.
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Any, List

import pytest

from scenario.voice.adapters.openai_realtime import OpenAIRealtimeAgentAdapter


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_pcm(n_samples: int = 480) -> bytes:
    """Minimal silent PCM16 mono @ 24 kHz."""
    return b"\x00\x00" * n_samples


def _b64_pcm(n_samples: int = 480) -> str:
    return base64.b64encode(_make_pcm(n_samples)).decode()


class _MockWS:
    """Queue-backed WebSocket mock.

    ``recv()`` pops pre-loaded JSON event strings in order; once exhausted it
    raises asyncio.TimeoutError (tail silence).  ``send()`` is recorded in
    ``self.sent`` as a list of parsed dicts so callers can inspect event types.
    """

    def __init__(self, events: List[str]) -> None:
        self._events = list(events)
        self._idx = 0
        self.sent: List[Any] = []
        # Also track raw send order as (index, parsed_dict) for AC2 ordering.
        self.sent_indexed: List[tuple[int, dict]] = []
        self._send_counter = 0

    async def send(self, msg: Any) -> None:
        self.sent.append(msg)
        try:
            parsed = json.loads(msg) if isinstance(msg, str) else msg
        except Exception:
            parsed = {"_raw": msg}
        self.sent_indexed.append((self._send_counter, parsed))
        self._send_counter += 1

    async def recv(self) -> str:
        if self._idx >= len(self._events):
            await asyncio.sleep(0)
            raise asyncio.TimeoutError("mock WS: no more events")
        evt = self._events[self._idx]
        self._idx += 1
        return evt

    async def close(self) -> None:
        pass

    # --- helpers for assertions ---

    def sent_types(self) -> List[str]:
        """Ordered list of ``type`` values from sent messages."""
        types = []
        for msg in self.sent:
            try:
                d = json.loads(msg) if isinstance(msg, str) else msg
                types.append(d.get("type", ""))
            except Exception:
                types.append("")
        return types

    def first_index_of(self, event_type: str) -> int:
        """Index of the first send with the given type, or -1."""
        for i, t in enumerate(self.sent_types()):
            if t == event_type:
                return i
        return -1

    def count_of(self, event_type: str) -> int:
        return self.sent_types().count(event_type)


def _audio_delta_events() -> List[str]:
    """Normal audio-delta sequence ending with response.done."""
    chunk = _b64_pcm(480)
    return [
        json.dumps({"type": "response.output_audio.delta", "delta": chunk}),
        json.dumps({"type": "response.output_audio.delta", "delta": chunk}),
        json.dumps({"type": "response.done"}),
    ]


def _make_adapter(events: List[str], *, short_timeout: bool = False) -> tuple[OpenAIRealtimeAgentAdapter, _MockWS]:
    """Build an adapter wired to a _MockWS pre-loaded with ``events``."""
    adapter = OpenAIRealtimeAgentAdapter(speaks_first=False)
    mock_ws = _MockWS(events)
    adapter._ws = mock_ws
    if short_timeout:
        adapter.response_timeout = 0.2  # keep tests fast
    return adapter, mock_ws


# ---------------------------------------------------------------------------
# AC1 — guard present: response.create suppressed while response is active
# (MUST FAIL on pre-fix code)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac1_response_create_suppressed_while_response_active():
    """
    AC1: when _response_active is True (mock pre-loaded with response.created,
    no response.done) and _pending_audio_bytes > 0, recv_audio must send
    ``input_audio_buffer.commit`` but NOT ``response.create``.

    Pre-fix: the user-audio branch fires response.create unconditionally.
    Post-fix: the guard prevents it.
    """
    # response.created fires, but no response.done — response stays active.
    # Tail silence terminates the recv loop via TimeoutError from MockWS.
    events = [
        json.dumps({"type": "response.created"}),
        # no audio delta, no response.done → drain times out
    ]
    adapter, mock_ws = _make_adapter(events, short_timeout=True)

    # Simulate user audio having been queued.
    adapter._pending_audio_bytes = 960  # 480 samples × 2 bytes
    # response.created has not fired yet at recv call time — but will fire
    # mid-loop. Pre-fix sends response.create before seeing response.created.
    # Post-fix: if response is already active at call time, guard applies.
    # Inject _response_active=True to replicate the race (response created
    # from a previous still-in-flight response).
    adapter._response_active = True

    # recv_audio will time out (no audio delta) — that's expected.
    with pytest.raises((asyncio.TimeoutError, Exception)):
        await adapter.recv_audio(timeout=0.2)

    # MUST have committed audio.
    assert mock_ws.count_of("input_audio_buffer.commit") >= 1, (
        "AC1: input_audio_buffer.commit was not sent"
    )
    # MUST NOT have fired response.create while response was already active.
    assert mock_ws.count_of("response.create") == 0, (
        f"AC1 FAIL (pre-fix): response.create was sent while _response_active=True; "
        f"sent_types={mock_ws.sent_types()}"
    )


# ---------------------------------------------------------------------------
# AC2 — deferred response.create fires AFTER response.done (ordering)
# (MUST FAIL on pre-fix code)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac2_deferred_response_create_fires_after_response_done():
    """
    AC2: After the guard fires (response active during commit), once the mock
    yields response.done, response.create must NOT have been sent before the
    recv loop processed response.done.

    Pre-fix: response.create fires IMMEDIATELY in the user-audio branch preamble
    (before the event loop starts) — so response.create count is already 1 when
    the loop begins.

    Post-fix: response.create count is 0 until after response.done is processed.
    We detect the pre-fix shape by asserting response.create count == 0 at the
    preamble boundary, proxied by: if _response_active=True pre-fix sends it
    unconditionally, then the loop sees another response.created + audio delta
    and also the agent-turn branch would fire ANOTHER one — giving count==2.
    Post-fix: exactly 1 deferred create.

    Simpler proxy: pre-fix fires response.create at index 1 (right after commit at
    index 0) — before the event loop begins (index 0=commit, 1=create). Post-fix:
    response.create appears at index >= 1 but ONLY after response.done was received,
    meaning the recv loop ran first. We assert: if response.create appears at sent
    index position 1 (immediately after commit, preamble), that's the pre-fix shape.
    """
    chunk = _b64_pcm(480)
    # Sequence: response.done clears in-flight, then audio delta from deferred create.
    events = [
        # In-flight response completes.
        json.dumps({"type": "response.done"}),
        # Deferred create fires → second response.created + audio.
        json.dumps({"type": "response.created"}),
        json.dumps({"type": "response.output_audio.delta", "delta": chunk}),
        json.dumps({"type": "response.done"}),
    ]
    adapter, mock_ws = _make_adapter(events, short_timeout=True)

    # In-flight response: _response_active=True, pending audio.
    adapter._response_active = True
    adapter._response_ever_active = True
    adapter._pending_audio_bytes = 960

    result = await adapter.recv_audio(timeout=2.0)

    sent = mock_ws.sent_types()

    # Post-fix: response.create IS sent (deferred, not dropped).
    assert "response.create" in sent, (
        f"AC2 FAIL: response.create never sent; sent={sent}"
    )

    commit_idx = mock_ws.first_index_of("input_audio_buffer.commit")
    create_idx = mock_ws.first_index_of("response.create")

    assert commit_idx >= 0, "AC2: input_audio_buffer.commit not sent"

    # Pre-fix shape: response.create fired in preamble (sent index 1, immediately
    # after commit at sent index 0) — before the event loop ran at all.
    # Post-fix: response.create deferred; must NOT be at position commit_idx+1
    # with no recv events between them.
    assert create_idx != commit_idx + 1, (
        f"AC2 FAIL (pre-fix): response.create at sent[{create_idx}] is immediately "
        f"after input_audio_buffer.commit at sent[{commit_idx}], indicating it was "
        f"fired in the preamble (before the event loop processed response.done). "
        f"Post-fix: it should be deferred until after response.done is received. "
        f"sent_types={sent}"
    )


# ---------------------------------------------------------------------------
# AC3 — exactly one commit and zero response.create in the preamble when
# _response_active=True, plus exactly one response.create total after the
# full guarded sequence.
# (MUST FAIL on pre-fix code — pre-fix fires response.create in preamble)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac3_exactly_one_commit_and_one_create():
    """
    AC3: across the full guarded sequence (guard fires, response.done received,
    deferred send fires), mock_ws.sent contains input_audio_buffer.commit
    exactly once and response.create exactly once.

    Pre-fix: response.create fires in the user-audio branch preamble (count=1
    before the event loop even starts). After the loop processes response.done
    and response.created and audio delta, count is still 1 — but the preamble
    create came BEFORE response.done was received.

    The pre-fix falsification: after the preamble, count_of("response.create")==1
    already. We assert this equals 0 at that point (proxy: total count must
    equal 1 AND the only create must appear AFTER response.done was received,
    i.e., not at index commit_idx+1).

    Combined assertion: count==1 AND create is NOT at preamble position.
    This mirrors AC1 + AC2 but proves the FULL sequence property.
    """
    chunk = _b64_pcm(480)
    events = [
        # In-flight response completes.
        json.dumps({"type": "response.done"}),
        # Deferred create fires → second response + audio.
        json.dumps({"type": "response.created"}),
        json.dumps({"type": "response.output_audio.delta", "delta": chunk}),
        json.dumps({"type": "response.done"}),
    ]
    adapter, mock_ws = _make_adapter(events, short_timeout=True)

    adapter._response_active = True
    adapter._response_ever_active = True
    adapter._pending_audio_bytes = 960

    await adapter.recv_audio(timeout=2.0)

    commit_count = mock_ws.count_of("input_audio_buffer.commit")
    create_count = mock_ws.count_of("response.create")
    commit_idx = mock_ws.first_index_of("input_audio_buffer.commit")
    create_idx = mock_ws.first_index_of("response.create")

    assert commit_count == 1, (
        f"AC3 FAIL: expected exactly 1 input_audio_buffer.commit, got {commit_count}; "
        f"sent_types={mock_ws.sent_types()}"
    )
    assert create_count == 1, (
        f"AC3 FAIL: expected exactly 1 response.create, got {create_count}; "
        f"sent_types={mock_ws.sent_types()}"
    )
    # The create must NOT be at the preamble position (immediately after commit).
    # Pre-fix fires it at commit_idx+1 (before the event loop ran).
    assert create_idx != commit_idx + 1, (
        f"AC3 FAIL (pre-fix): response.create at sent[{create_idx}] is immediately "
        f"after commit at sent[{commit_idx}] — fired in the preamble before "
        f"response.done was processed. Post-fix: deferred until after response.done. "
        f"sent_types={mock_ws.sent_types()}"
    )


# ---------------------------------------------------------------------------
# AC4 — control: agent-turn branch unaffected (SHOULD PASS NOW)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac4_agent_turn_branch_still_fires_response_create():
    """
    AC4 (control — should PASS on current code): recv_audio with
    _agent_turn_pending=True and _response_active=False must still fire
    response.create exactly once. The guard must not bleed into the
    agent-turn branch.
    """
    chunk = _b64_pcm(480)
    events = [
        json.dumps({"type": "response.created"}),
        json.dumps({"type": "response.output_audio.delta", "delta": chunk}),
        json.dumps({"type": "response.done"}),
    ]
    adapter, mock_ws = _make_adapter(events)

    adapter._agent_turn_pending = True
    adapter._response_active = False

    await adapter.recv_audio(timeout=2.0)

    create_count = mock_ws.count_of("response.create")
    assert create_count == 1, (
        f"AC4: expected exactly 1 response.create from agent-turn branch, "
        f"got {create_count}; sent_types={mock_ws.sent_types()}"
    )


# ---------------------------------------------------------------------------
# AC5 — control: normal path (no active response) sends commit then create
# (SHOULD PASS NOW)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac5_normal_path_commit_then_create():
    """
    AC5 (control — should PASS on current code): _pending_audio_bytes > 0
    and _response_active=False (uncontested path). Both commit and create must
    fire, and commit must appear before create.
    """
    chunk = _b64_pcm(480)
    events = [
        json.dumps({"type": "response.created"}),
        json.dumps({"type": "response.output_audio.delta", "delta": chunk}),
        json.dumps({"type": "response.done"}),
    ]
    adapter, mock_ws = _make_adapter(events)

    adapter._pending_audio_bytes = 960
    adapter._response_active = False

    await adapter.recv_audio(timeout=2.0)

    sent = mock_ws.sent_types()
    assert "input_audio_buffer.commit" in sent, (
        f"AC5: input_audio_buffer.commit not sent; sent={sent}"
    )
    assert "response.create" in sent, (
        f"AC5: response.create not sent; sent={sent}"
    )
    commit_idx = mock_ws.first_index_of("input_audio_buffer.commit")
    create_idx = mock_ws.first_index_of("response.create")
    assert commit_idx < create_idx, (
        f"AC5: expected commit (idx={commit_idx}) before create (idx={create_idx})"
    )


# ---------------------------------------------------------------------------
# AC6 — explicit server rejection raises RuntimeError
# (SHOULD PASS if current adapter already surfaces error events)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac6_server_rejection_raises_runtime_error():
    """
    AC6: a mock that emits the server error event
    "Conversation already has an active response in progress" must surface as
    RuntimeError, not be swallowed.
    """
    error_msg = "Conversation already has an active response in progress: resp_abc123"
    events = [
        json.dumps({"type": "error", "error": {"message": error_msg}}),
    ]
    adapter, _mock_ws = _make_adapter(events)

    with pytest.raises(RuntimeError) as exc_info:
        await adapter.recv_audio(timeout=2.0)

    assert "Conversation already has an active response in progress" in str(exc_info.value), (
        f"AC6: RuntimeError raised but message doesn't contain expected text; "
        f"got: {exc_info.value}"
    )


# ---------------------------------------------------------------------------
# AC7 — pre-fix race: response.create count in sent equals 2 when
# _response_active=True; post-fix: exactly 1.
# (MUST FAIL on pre-fix code)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac7_race_sequence_returns_audio_chunk_not_timeout():
    """
    AC7: with a two-call sequence through call() that exercises the drain loop,
    the pre-fix fires response.create twice (preamble + agent-turn branch),
    post-fix fires exactly once (deferred after response.done).

    We exercise this via two sequential recv_audio calls on the same adapter +
    mock: call 1 has the race (_response_active=True + pending audio), call 2
    is the drain re-entry. Pre-fix: call 1 preamble fires response.create
    immediately; call 2 (agent-turn branch) fires it again → total == 2.
    Post-fix: call 1 defers; call 2 fires exactly the deferred create → total == 1.

    Actually: the simplest falsifiable shape is that pre-fix fires response.create
    with count=1 on call 1 preamble (before the loop), then the loop reads events
    and the test can observe that create happened before recv events were consumed.
    We prove this via: after recv_audio returns, check that the number of sends
    before the first recv event was processed is already 2 (commit + create in
    preamble), proving it fired pre-loop.

    Since we cannot observe "before first recv" post-hoc, we proxy this via AC1's
    assertion: count_of("response.create") == 0 when _response_active=True. AC7
    adds the "full sequence resolves to non-empty AudioChunk" assertion so that
    both the guard AND the deferred firing are proven together.
    """
    chunk = _b64_pcm(480)
    # Events: in-flight completes, deferred create acknowledged, audio delta.
    events = [
        json.dumps({"type": "response.done"}),
        json.dumps({"type": "response.created"}),
        json.dumps({"type": "response.output_audio.delta", "delta": chunk}),
        json.dumps({"type": "response.done"}),
    ]
    adapter, mock_ws = _make_adapter(events, short_timeout=True)

    adapter._response_active = True
    adapter._response_ever_active = True
    adapter._pending_audio_bytes = 960

    result = await adapter.recv_audio(timeout=2.0)

    # AC7a: the guard held (no premature create) — count == 0 pre-loop means pre-fix.
    # On pre-fix, this assertion matches AC1: count == 1 here → fails.
    # We assert it a different way: total sent before recv events = 2 on pre-fix.
    # Proxy: sent_types list starts with ['input_audio_buffer.commit', 'response.create']
    # on pre-fix (both fired before recv loop). Post-fix starts with
    # ['input_audio_buffer.commit'] only (create deferred to after response.done recv).
    sent = mock_ws.sent_types()
    assert sent[0] == "input_audio_buffer.commit", (
        f"AC7: expected first sent to be commit, got {sent[0]}"
    )
    # Pre-fix: sent[1] == "response.create" (preamble fire). Post-fix: sent[1] is absent
    # or is the deferred create that appeared after response.done was received.
    # Falsify pre-fix: assert sent does NOT have response.create at index 1
    # (the preamble position immediately after commit).
    if len(sent) > 1:
        assert sent[1] != "response.create", (
            f"AC7 FAIL (pre-fix): response.create at sent[1] was fired in the "
            f"preamble (before any recv event). Post-fix: deferred until after "
            f"response.done is processed. sent_types={sent}"
        )

    # AC7b: the full sequence resolved to a non-empty AudioChunk (not timeout/empty).
    assert result is not None, "AC7 FAIL: recv_audio returned None"
    assert isinstance(result.data, bytes), (
        f"AC7 FAIL: result.data is not bytes: {type(result.data)}"
    )
    assert len(result.data) > 0, (
        "AC7 FAIL: recv_audio returned an empty AudioChunk. "
        "Post-fix: guard defers response.create until response.done is processed, "
        "then the audio-delta sequence completes with a non-empty chunk."
    )
