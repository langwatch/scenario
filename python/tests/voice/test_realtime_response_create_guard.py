"""
Issue #657 — regression tests for recv_audio response.create race condition.

The user-audio branch at lines ~407-411 of openai_realtime.py sends
``response.create`` unconditionally after ``input_audio_buffer.commit``, even
while ``self._response_active`` is True (set on response.created, cleared on
response.done/response.cancelled).  The agent-turn elif at ~line 423 already
guards on ``not self._response_active``.

Fix (NOT in this file): add the same guard to the user-audio branch and defer
the create by setting ``_deferred_response_create=True`` so it fires after
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

    ``log`` is a single interleaved chronological sequence of
    ``("sent", type_str)`` and ``("recv", type_str)`` tuples — one entry per
    adapter send and one per mock yield.  This allows true ordering assertions
    (e.g. "response.create was not sent before response.done was received")
    without relying on send-only position proxies.
    """

    def __init__(self, events: List[str]) -> None:
        self._events = list(events)
        self._idx = 0
        self.sent: List[Any] = []
        # Interleaved chronological log: ("sent"|"recv", type_str)
        self.log: List[tuple[str, str]] = []

    async def send(self, msg: Any) -> None:
        self.sent.append(msg)
        try:
            d = json.loads(msg) if isinstance(msg, str) else msg
            t = d.get("type", "")
        except Exception:
            t = ""
        self.log.append(("sent", t))

    async def recv(self) -> str:
        if self._idx >= len(self._events):
            await asyncio.sleep(0)
            raise asyncio.TimeoutError("mock WS: no more events")
        evt = self._events[self._idx]
        self._idx += 1
        try:
            t = json.loads(evt).get("type", "")
        except Exception:
            t = ""
        self.log.append(("recv", t))
        return evt

    async def close(self) -> None:
        pass

    # --- helpers for assertions ---

    def sent_types(self) -> List[str]:
        """Ordered list of ``type`` values from sent messages."""
        return [t for (kind, t) in self.log if kind == "sent"]

    def first_index_of(self, event_type: str) -> int:
        """Index of the first send with the given type in sent_types(), or -1."""
        for i, t in enumerate(self.sent_types()):
            if t == event_type:
                return i
        return -1

    def count_of(self, event_type: str) -> int:
        return self.sent_types().count(event_type)

    def log_index_of_first(self, kind: str, event_type: str) -> int:
        """Index in the interleaved log of the first entry matching (kind, event_type), or -1."""
        for i, entry in enumerate(self.log):
            if entry == (kind, event_type):
                return i
        return -1


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
    """AC1: recv_audio sends commit but NOT response.create when _response_active=True."""
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
    with pytest.raises((asyncio.TimeoutError, RuntimeError)):
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
    """AC2: deferred response.create appears in the interleaved log AFTER response.done is received."""
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

    await adapter.recv_audio(timeout=2.0)

    sent = mock_ws.sent_types()

    # Post-fix: response.create IS sent (deferred, not dropped).
    assert "response.create" in sent, (
        f"AC2 FAIL: response.create never sent; sent={sent}"
    )

    assert mock_ws.first_index_of("input_audio_buffer.commit") >= 0, (
        "AC2: input_audio_buffer.commit not sent"
    )

    # True ordering assertion using the interleaved log: the first
    # ("sent","response.create") entry must appear AFTER the first
    # ("recv","response.done") entry.  Pre-fix fires response.create in the
    # preamble before the recv loop starts, so it precedes every recv entry.
    log_create = mock_ws.log_index_of_first("sent", "response.create")
    log_done   = mock_ws.log_index_of_first("recv", "response.done")

    assert log_done >= 0, f"AC2: response.done never received; log={mock_ws.log}"
    assert log_create > log_done, (
        f"AC2 FAIL (pre-fix): response.create appeared at log[{log_create}] "
        f"before or at response.done at log[{log_done}], indicating it was fired "
        f"in the preamble (before the event loop processed response.done). "
        f"Post-fix: deferred until after response.done is received. log={mock_ws.log}"
    )


# ---------------------------------------------------------------------------
# AC3 — exactly one commit and zero response.create in the preamble when
# _response_active=True, plus exactly one response.create total after the
# full guarded sequence.
# (MUST FAIL on pre-fix code — pre-fix fires response.create in preamble)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac3_exactly_one_commit_and_one_create():
    """AC3: full guarded sequence produces exactly one commit and one response.create, ordered after response.done."""
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

    assert commit_count == 1, (
        f"AC3 FAIL: expected exactly 1 input_audio_buffer.commit, got {commit_count}; "
        f"sent_types={mock_ws.sent_types()}"
    )
    assert create_count == 1, (
        f"AC3 FAIL: expected exactly 1 response.create, got {create_count}; "
        f"sent_types={mock_ws.sent_types()}"
    )
    # True ordering assertion: response.create must appear after response.done
    # in the interleaved log.  Pre-fix fires response.create in the preamble,
    # which always precedes any recv entry.
    log_create = mock_ws.log_index_of_first("sent", "response.create")
    log_done   = mock_ws.log_index_of_first("recv", "response.done")
    assert log_done >= 0, f"AC3: response.done never received; log={mock_ws.log}"
    assert log_create > log_done, (
        f"AC3 FAIL (pre-fix): response.create at log[{log_create}] appeared before "
        f"response.done at log[{log_done}] — fired in the preamble before the event "
        f"loop processed response.done. Post-fix: deferred until after response.done. "
        f"log={mock_ws.log}"
    )


# ---------------------------------------------------------------------------
# AC4 — control: agent-turn branch unaffected (SHOULD PASS NOW)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ac4_agent_turn_branch_still_fires_response_create():
    """AC4 (control): agent-turn branch fires response.create exactly once; guard does not bleed into it."""
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
    """AC5 (control): normal uncontested path sends commit then response.create in order."""
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
    """AC6: server error event "Conversation already has an active response in progress" surfaces as RuntimeError."""
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
    """AC7: race sequence that pre-fix timed out now returns a non-empty AudioChunk; response.create ordered after response.done."""
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

    # AC7a: true ordering — response.create must appear after response.done in
    # the interleaved log.  Pre-fix fires response.create in the preamble before
    # any recv event, so log_create < log_done on pre-fix code.
    log_create = mock_ws.log_index_of_first("sent", "response.create")
    log_done   = mock_ws.log_index_of_first("recv", "response.done")

    assert "response.create" in mock_ws.sent_types(), (
        f"AC7 FAIL: response.create never sent; log={mock_ws.log}"
    )
    assert log_done >= 0, f"AC7: response.done never received; log={mock_ws.log}"
    assert log_create > log_done, (
        f"AC7 FAIL (pre-fix): response.create at log[{log_create}] appeared before "
        f"response.done at log[{log_done}] — fired in the preamble before any recv "
        f"event. Post-fix: deferred until after response.done. log={mock_ws.log}"
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


# ---------------------------------------------------------------------------
# Deferred path also consumes the agent-turn signal: when user audio is
# committed while a response is in flight, recv_audio takes the deferral
# branch (_deferred_response_create=True) and MUST also clear
# _agent_turn_pending (openai_realtime.py line 428) — the user spoke, so the
# pending agent-turn signal is consumed even though the create is deferred.
# Without that clear, a later drain re-entry would fire a spurious
# response.create off the still-pending agent-turn flag.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_deferred_path_clears_agent_turn_pending():
    """Deferred branch clears _agent_turn_pending (line 428) when user audio is committed mid-response."""
    # response.created fires, but no response.done — response stays active and
    # no audio delta arrives, so the drain terminates via TimeoutError from the
    # MockWS (same shape as AC1). The flag clear happens in the preamble before
    # the recv loop, so the timeout does not affect what we assert.
    events = [
        json.dumps({"type": "response.created"}),
    ]
    adapter, _mock_ws = _make_adapter(events, short_timeout=True)

    # Both flags set: an agent turn is pending AND a response is already in
    # flight. User audio committed below → preamble takes the deferral branch.
    adapter._agent_turn_pending = True
    adapter._response_active = True
    adapter._pending_audio_bytes = 960  # 480 samples × 2 bytes

    # recv_audio times out (no audio delta, no response.done) — expected.
    with pytest.raises((asyncio.TimeoutError, RuntimeError)):
        await adapter.recv_audio(timeout=0.2)

    # The deferral branch must have consumed the agent-turn signal (line 428).
    assert adapter._agent_turn_pending is False, (
        "deferred path did not clear _agent_turn_pending; a later drain "
        "re-entry would fire a spurious response.create off the stale flag"
    )
    # Sanity: it really was the deferral branch (flag set), not the else branch.
    assert adapter._deferred_response_create is True, (
        "expected the deferral branch (_deferred_response_create=True) to be taken"
    )
