"""When the agent under test never sends its first audio chunk, the voice
adapter's drain loop times out — and that timeout must be *attributable*.

Regression target for #498 (diagnostic-surfacing slice, creds-free half).

Mechanism of the bug: ``VoiceAgentAdapter._drain_agent_response`` awaits the
first chunk via ``recv_audio(timeout=self.response_timeout)`` (adapter.py:205).
That call is NOT wrapped — a transport ``asyncio.TimeoutError`` propagates
verbatim. Because ``str(asyncio.TimeoutError())`` is ``""`` and its ``.args``
are empty, the error that escapes carries *no* signal:

  - which timeout fired (the first-chunk ``response_timeout`` vs the
    per-chunk ``response_tail_silence``), and
  - what the configured timeout value actually was.

The executor re-raise (``[{agent_name}] {error_detail}``) was already fixed
under #500/#547 to fall back to the type name, so operators now at least see
``[PipecatAgentAdapter] TimeoutError`` instead of ``[PipecatAgentAdapter]``.
But "TimeoutError" alone still cannot tell a first-chunk hang (agent never
spoke — likely wrong endpoint / VAD never fired / response_timeout too short)
apart from a mid-response tail-silence cutoff. This test pins the *upstream*
fix: the adapter must surface that context at the raise site.

No credentials, no live transport: a dummy adapter (a real
``VoiceAgentAdapter`` subclass) overrides only the abstract transport methods
and makes ``recv_audio`` raise a bare ``asyncio.TimeoutError()`` — exactly what
``pipecat.PipecatAgentAdapter.recv_audio`` / ``asyncio.wait_for`` raise on a
real first-chunk timeout. The inherited ``_drain_agent_response`` (the line
under test) runs unmodified.

Test 2 is the falsifiable counterpart: once the first chunk *does* arrive, a
subsequent tail-silence timeout must NOT raise — it ends the drain and returns
the collected audio. Without this guard, "attributable first-chunk timeout"
could be satisfied by re-raising on *every* recv timeout, which would break the
normal end-of-turn signal. The two tests together pin "raise on first-chunk
timeout, stay silent on tail-silence timeout."
"""

from __future__ import annotations

import asyncio

import pytest

from scenario.voice import (
    AdapterCapabilities,
    AudioChunk,
    VoiceAgentAdapter,
)

# Import the module (not the constant directly) so a missing _FIRST_CHUNK_PHASE
# fails only the test that dereferences it, not collection.
from scenario.voice import adapter as _adapter_mod

# A deliberately non-default value so the assertion proves the *configured*
# number is surfaced, not a coincidental default.
_SENTINEL_TIMEOUT = 0.05


class _FirstChunkTimeoutAdapter(VoiceAgentAdapter):
    """Real adapter whose transport never yields a first chunk.

    Overrides only the four abstract transport hooks; the drain logic under
    test is inherited from ``VoiceAgentAdapter`` unchanged.
    """

    # The drain/timeout path reads no capability field; bare defaults suffice.
    capabilities = AdapterCapabilities()

    async def connect(self) -> None:
        pass

    async def disconnect(self) -> None:
        pass

    async def send_audio(self, chunk: AudioChunk) -> None:
        pass

    async def recv_audio(self, timeout: float) -> AudioChunk:
        # Mirror what `asyncio.wait_for(queue.get(), timeout)` raises in
        # pipecat.PipecatAgentAdapter.recv_audio when no agent audio arrives:
        # a bare, message-less TimeoutError.
        raise asyncio.TimeoutError()


class _TailSilenceTimeoutAdapter(VoiceAgentAdapter):
    """Real adapter where the first chunk arrives, then tail-silence times out.

    First ``recv_audio`` returns one real chunk (agent started speaking); the
    second raises ``asyncio.TimeoutError`` — the natural "agent finished
    talking" signal. The inherited drain must absorb that and return the
    collected audio, NOT propagate the timeout.
    """

    # One real chunk of agent audio. Non-empty data so the drain's
    # ``first.data`` branch fires and the chunk is collected.
    FIRST_CHUNK = AudioChunk(data=b"\x01\x02" * 600, transcript="hello")

    # The drain/timeout path reads no capability field; bare defaults suffice.
    capabilities = AdapterCapabilities()

    def __init__(self) -> None:
        super().__init__()
        self._calls = 0

    async def connect(self) -> None:
        pass

    async def disconnect(self) -> None:
        pass

    async def send_audio(self, chunk: AudioChunk) -> None:
        pass

    async def recv_audio(self, timeout: float) -> AudioChunk:
        # Call 1: first chunk on the wire. Call 2+: tail silence (timeout).
        self._calls += 1
        if self._calls == 1:
            return self.FIRST_CHUNK
        raise asyncio.TimeoutError()


@pytest.mark.asyncio
async def test_first_chunk_timeout_is_attributable():
    """The error escaping the drain on a first-chunk timeout must be
    attributable: non-empty body, a code-owned phase marker (not an English
    word), a structured ``.timeout`` attribute equal to the configured value,
    and a ``__cause__`` chaining the original transport ``TimeoutError``.

    RED against current code: the first-chunk ``recv_audio`` call is unwrapped,
    so a bare ``asyncio.TimeoutError`` (``str() == ""``, no ``.timeout``, no
    ``__cause__``) escapes verbatim. The first assertion to fail will be the
    phase-marker dereference (``_adapter_mod._FIRST_CHUNK_PHASE`` does not yet
    exist) — by design, that is the coder's contract symbol.
    """
    adapter = _FirstChunkTimeoutAdapter()
    adapter.response_timeout = _SENTINEL_TIMEOUT

    # We assert on ``asyncio.TimeoutError`` because that is the transport-native
    # exception class. On Python >= 3.11 ``asyncio.TimeoutError is TimeoutError``,
    # so the *type* alone proves nothing — the contract is the message + the
    # ``.timeout`` attribute + the chained ``__cause__``, asserted below.
    with pytest.raises(asyncio.TimeoutError) as excinfo:
        await adapter._drain_agent_response()

    message = str(excinfo.value)

    # AC1 — body must never be blank: the whole point of the diagnostic slice.
    assert message.strip(), (
        "first-chunk timeout escaped with a blank body — operators get no "
        f"signal; got: {message!r}"
    )

    # AC2a — phase marker is CODE-OWNED, not an English substring. Reference the
    # constant the coder will define so the marker and the assertion cannot
    # drift apart and a reviewer cannot satisfy it with a stray word like
    # "first" elsewhere in the sentence. (Dereferencing the not-yet-defined
    # constant is the intended RED point for this test.)
    assert _adapter_mod._FIRST_CHUNK_PHASE in message, (
        "timeout message must embed the code-owned first-chunk phase marker "
        f"({_adapter_mod._FIRST_CHUNK_PHASE!r}) so it is distinguishable from a "
        f"tail-silence cutoff; got: {message!r}"
    )

    # AC2b — configured timeout surfaced as a STRUCTURED attribute, not scraped
    # from the message. ``str(timeout) in message`` false-passes on substrings
    # (0.05 matches "10.05") and breaks on float formatting (0.05 vs 5e-02);
    # a typed attribute is formatting-proof and machine-readable.
    assert excinfo.value.timeout == _SENTINEL_TIMEOUT, (  # type: ignore[attr-defined]
        "raised error must carry a structured .timeout attribute equal to the "
        f"configured response_timeout ({_SENTINEL_TIMEOUT}); got: "
        f"{getattr(excinfo.value, 'timeout', '<missing>')!r}"
    )

    # AC-cause — the re-raise must CHAIN the original transport timeout
    # (``raise ... from err``) so the underlying error is not lost.
    assert isinstance(excinfo.value.__cause__, asyncio.TimeoutError), (
        "re-raised error must chain the original transport TimeoutError as its "
        f"__cause__ (raise ... from err); got: {excinfo.value.__cause__!r}"
    )


@pytest.mark.asyncio
async def test_tail_silence_timeout_ends_drain_without_raising():
    """Once the first chunk has arrived, a tail-silence ``recv_audio`` timeout
    must END the drain and RETURN the collected audio — never propagate.

    GREEN against current code: the tail-silence recv is already wrapped in a
    try/except that ``break``s the loop. This is the falsifiable counterpart to
    Test 1 — it proves the first-chunk fix must be *scoped* to the first recv
    and not turn every recv timeout into a raise.

    Return shape: with exactly one chunk collected, ``_drain_agent_response``
    returns that chunk via ``_merge_chunks`` (single-chunk path returns the
    chunk unchanged), so the result carries the first chunk's data verbatim.
    """
    adapter = _TailSilenceTimeoutAdapter()
    # Keep the sentinel here too so a future first-chunk re-raise (if it ever
    # leaked into this path) would be obvious — but this path must not raise.
    adapter.response_timeout = _SENTINEL_TIMEOUT

    # Must RETURN, not raise: any TimeoutError here is a regression.
    result = await adapter._drain_agent_response()

    assert isinstance(result, AudioChunk), (
        f"drain must return a merged AudioChunk after tail silence; got: {result!r}"
    )
    # Single collected chunk → _merge_chunks returns it unchanged, so the data
    # is the first chunk's data verbatim.
    assert result.data == _TailSilenceTimeoutAdapter.FIRST_CHUNK.data, (
        "returned audio must contain the first chunk's data after the "
        f"tail-silence cutoff; got {len(result.data)} bytes"
    )


# ---------------------------------------------------------------- #
# Part 2 — AgentStreamEndedError propagation (#498 diagnostic slice) #
# ---------------------------------------------------------------- #
#
# Two tests pin the contract for when the adapter's transport terminates:
#
#   A. recv_audio raises AgentStreamEndedError on the FIRST call
#      (loop crashed / peer closed before any audio) →
#      _drain_agent_response PROPAGATES the error unchanged, does NOT
#      wrap it in FirstChunkTimeoutError.
#
#   B. recv_audio returns one real chunk THEN raises AgentStreamEndedError
#      (clean close after turn-1 audio) →
#      _drain_agent_response treats it like tail-silence and RETURNS the
#      collected audio without raising.
#
# Both tests reference new symbols via _adapter_mod so a missing symbol
# fails only the dereferencing assertion, not import-time collection.


class _StreamEndedOnFirstAdapter(VoiceAgentAdapter):
    """Transport terminates before any audio chunk — recv_audio raises
    AgentStreamEndedError on the very first call.

    __cause__ is set to a ConnectionResetError so we can verify the cause
    is threaded through unchanged by _drain_agent_response.
    """

    capabilities = AdapterCapabilities()

    _SENTINEL_MSG = "sentinel stream ended message"
    _CAUSE = ConnectionResetError("peer reset")

    async def connect(self) -> None:
        pass

    async def disconnect(self) -> None:
        pass

    async def send_audio(self, chunk: AudioChunk) -> None:
        pass

    async def recv_audio(self, timeout: float) -> AudioChunk:
        # Raise the new contract exception — exactly what PipecatAgentAdapter
        # will raise when its _recv_loop has terminated and the queue is drained.
        # We raise it with __cause__ so the propagation test can check it too.
        exc = _adapter_mod.AgentStreamEndedError(self._SENTINEL_MSG)
        exc.__cause__ = self._CAUSE
        raise exc


class _StreamEndedAfterFirstChunkAdapter(VoiceAgentAdapter):
    """Transport delivers one real chunk then closes cleanly.

    Call 1: returns a non-empty AudioChunk.
    Call 2+: raises AgentStreamEndedError — transport is gone.

    This mirrors the #498 scenario: turn-1 audio OK, then on the next
    drain's tail recv the loop has exited.  Expected: drain returns the
    collected audio, same as a tail-silence asyncio.TimeoutError.
    """

    FIRST_CHUNK = AudioChunk(data=b"\x03\x04" * 600, transcript="world")

    capabilities = AdapterCapabilities()

    def __init__(self) -> None:
        super().__init__()
        self._calls = 0

    async def connect(self) -> None:
        pass

    async def disconnect(self) -> None:
        pass

    async def send_audio(self, chunk: AudioChunk) -> None:
        pass

    async def recv_audio(self, timeout: float) -> AudioChunk:
        self._calls += 1
        if self._calls == 1:
            return self.FIRST_CHUNK
        raise _adapter_mod.AgentStreamEndedError("stream closed after first chunk")


@pytest.mark.asyncio
async def test_first_chunk_stream_ended_propagates_unchanged():
    """When the transport ends BEFORE the first chunk, _drain_agent_response
    must propagate AgentStreamEndedError UNCHANGED — not re-wrap it as
    FirstChunkTimeoutError (which would bury the real cause).

    RED against current code: AgentStreamEndedError does not yet exist in
    scenario.voice.adapter, so dereferencing _adapter_mod.AgentStreamEndedError
    raises AttributeError at the assertion line (not at collection time).

    The two falsifiable properties:
      1. The raised type IS AgentStreamEndedError (str matches sentinel).
      2. The raised type is NOT FirstChunkTimeoutError (anti-relabel check).
    """
    adapter = _StreamEndedOnFirstAdapter()
    adapter.response_timeout = _SENTINEL_TIMEOUT

    # Dereference the not-yet-defined contract symbol; fails RED if absent.
    AgentStreamEndedError = _adapter_mod.AgentStreamEndedError  # noqa: N806

    with pytest.raises(AgentStreamEndedError) as excinfo:
        await adapter._drain_agent_response()

    # AC1 — message is the sentinel we embedded, passed through verbatim.
    assert str(excinfo.value) == _StreamEndedOnFirstAdapter._SENTINEL_MSG, (
        "AgentStreamEndedError message must propagate unchanged; "
        f"got: {str(excinfo.value)!r}"
    )

    # AC2 — __cause__ is the ConnectionResetError we set, not lost or replaced.
    assert excinfo.value.__cause__ is _StreamEndedOnFirstAdapter._CAUSE, (
        "AgentStreamEndedError.__cause__ must be the original ConnectionResetError; "
        f"got: {excinfo.value.__cause__!r}"
    )

    # AC3 — critical anti-relabel: must NOT be a FirstChunkTimeoutError.
    # If _drain_agent_response catches AgentStreamEndedError and re-wraps it
    # as FirstChunkTimeoutError (as the old asyncio.TimeoutError branch did),
    # this assertion catches the regression.
    assert not isinstance(excinfo.value, _adapter_mod.FirstChunkTimeoutError), (
        "AgentStreamEndedError on first recv must NOT be re-wrapped as "
        "FirstChunkTimeoutError — that hides the real transport failure cause"
    )


@pytest.mark.asyncio
async def test_tail_stream_ended_ends_drain_without_raising():
    """When the transport closes AFTER the first chunk, _drain_agent_response
    must return the collected audio (treating the close like tail-silence) —
    NOT raise AgentStreamEndedError.

    This is the falsifiable guard that the first-chunk propagation fix is
    SCOPED to the first recv: if the fix re-raised on every recv_audio
    AgentStreamEndedError, this test would catch it as a regression.

    Return shape: single collected chunk → _merge_chunks returns it
    unchanged, so result.data equals the first chunk's data verbatim.
    """
    adapter = _StreamEndedAfterFirstChunkAdapter()
    adapter.response_timeout = _SENTINEL_TIMEOUT

    # Dereference contract symbol (fails RED if absent — same as test above).
    _AgentStreamEndedError = _adapter_mod.AgentStreamEndedError  # noqa: F841

    # Must RETURN, not raise.
    result = await adapter._drain_agent_response()

    assert isinstance(result, AudioChunk), (
        f"drain must return an AudioChunk after tail-close; got: {result!r}"
    )
    assert result.data == _StreamEndedAfterFirstChunkAdapter.FIRST_CHUNK.data, (
        "returned audio must equal the first chunk's data; "
        f"got {len(result.data)} bytes"
    )
