"""A dead Gemini Live session must surface ``AgentStreamEndedError`` from
``recv_audio`` instead of starving it (issue #718).

``_session_lifetime`` (``gemini_live.py:234-254``) records a session failure on
``self._session_error`` and then RETURNS — which exits the ``async with
client.aio.live.connect(...)`` block and closes the SDK session. ``recv_audio``
holds a cached iterator obtained from that same session (``:389``), parks on
``await self._recv_iter.__anext__()`` (``:411``), and never consults
``_session_error`` or ``_session_task``. A dead session therefore starves the
consumer until the caller's own timeout.

Three properties are pinned separately, because each is a distinct way a naive
fix still ships the bug:

1. ``recv_audio`` never reads the crash state at all.
2. An ENTRY-ONLY check is insufficient. The production hang is a consumer
   ALREADY PARKED inside ``__anext__()`` when the session dies — the same lesson
   as #648: a sentinel test only discriminates if a consumer is already blocked
   when the stream ends.
3. ``_session_error`` is assigned ONLY inside ``except Exception:``, so a task
   that was cancelled (``CancelledError`` is a ``BaseException``) or returned
   cleanly leaves it ``None`` while the hang persists. Task-done is the trigger;
   ``_session_error`` only supplies the cause when there is one.

Expected status against UNMODIFIED production code (the #718 AC5 red-before):

    RED   test_crashed_session_task_surfaces_stream_ended
    RED   test_clean_task_exit_surfaces_stream_ended[clean_return]
    RED   test_clean_task_exit_surfaces_stream_ended[cancelled]
    RED   test_parked_recv_audio_wakes_on_session_death          <- discriminating
    RED   test_teardown_recv_iter_aclose_wakes_parked_recv
    RED   test_teardown_session_task_cleared_wakes_parked_recv
    RED   test_teardown_session_error_cleared_wakes_parked_recv
    GREEN test_pre_connect_failure_propagates_unchanged          <- regression lock
    GREEN test_clean_turn_reports_terminal_chunk                 <- regression lock

Every RED node fails by HANGING to its 5s ``asyncio.wait_for`` guard, which is
the evidence shape AC5 requires. That is why ``GeminiLiveRecvError`` is resolved
with ``getattr`` INSIDE the assertions rather than imported at module level: a
module-level import of a symbol that does not exist yet errors COLLECTION, and a
collection error is not a hang — it would make the red-before signal
unobtainable and mask which nodes genuinely fail. Only
``AgentStreamEndedError`` (which exists today) is imported up top.

Mock strategy — creds-free, and structurally so:
- The vendor transport is faked at the NETWORK CLIENT boundary (``genai.Client``),
  never by substituting a stub for adapter privates — the ban PR #697 exists for.
  The REAL ``connect()`` therefore runs: the real ``LiveConnectConfig``, the real
  ``_session_lifetime`` background task, the real ``except Exception`` capture.
- Credentials are removed with ``monkeypatch.delenv`` INSIDE the test, because
  ``tests/voice/conftest.py`` calls ``load_dotenv(python/.env)`` at import time
  and silently restores anything the process was started without (#871) — so a
  process-level ``env -u`` proves nothing here.
- No ``skipif`` / ``importorskip`` / ``pytestmark`` / ``pytest.skip``, and no
  ``@pytest.mark.integration`` (CI runs ``-m "not integration"``, which would
  silently deselect the node).
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any, List, NamedTuple, Optional

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.util._once import Once

import scenario.voice as scenario_voice
from scenario.voice import AgentStreamEndedError
from scenario.voice.adapters.gemini_live import GeminiLiveAgentAdapter
from scenario.voice.audio_chunk import AudioChunk
from scenario.voice.testing import drive_call, make_agent_input

from ._span_assert import attrs


# The adapter never reaches a real Google endpoint here — ``genai.Client`` is
# replaced — so this is a placeholder, not a credential.
_FAKE_KEY = "test-gk-not-a-real-key"

# Outer guard on every direct ``recv_audio(timeout=30.0)`` call. A blind hang
# must FAIL the test fast, not pass slowly: if the guard fires we get
# ``asyncio.TimeoutError`` instead of the expected error type, and
# ``_assert_stream_ended`` names the hang explicitly.
_RECV_GUARD_SECONDS = 5.0

# What ``recv_audio`` is asked for. Deliberately far above the guard so "the
# call returned because ITS OWN timeout elapsed" can never be mistaken for
# "the guard woke it".
_RECV_TIMEOUT_SECONDS = 30.0


# --------------------------------------------------------------------------- #
# Creds-free floor                                                            #
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def _creds_free_env(monkeypatch):
    """Delete every credential these tests must never need, INSIDE the test.

    ``monkeypatch.delenv`` rather than a process-level ``env -u``: the voice
    conftest reloads ``python/.env`` at import time, which re-populates any var
    the process was started without (#871), so only an in-test deletion holds.
    """
    for key in (
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "LANGWATCH_API_KEY",
        "LANGWATCH_ENDPOINT",
    ):
        monkeypatch.delenv(key, raising=False)


@pytest.fixture
def in_memory_spans():
    """Install a fresh in-memory TracerProvider and hand back its exporter.

    The provider is set-once globally, so the guard is reset on both edges —
    otherwise a provider installed by an earlier module wins and this module's
    span assertions read an empty exporter.
    """

    def _reset() -> None:
        trace._TRACER_PROVIDER = None
        trace._TRACER_PROVIDER_SET_ONCE = Once()

    _reset()
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    yield exporter
    _reset()


# --------------------------------------------------------------------------- #
# Duck-typed SDK stand-ins (no google.genai types are constructed here)        #
# --------------------------------------------------------------------------- #


class _ParkingReceiveStream:
    """Stand-in for the async generator ``session.receive()`` returns.

    ``__anext__`` parks forever — the session is alive but silent — which is the
    state the production consumer is in when the session dies underneath it.

    ``aclose()`` models the NATIVE async-generator semantics a parked consumer
    provokes: ``RuntimeError('aclose(): asynchronous generator is already
    running')``, which ``disconnect()`` swallows at ``gemini_live.py:279-284``.
    Modelling it on a plain object (rather than relying on a real generator)
    is what lets the teardown node PROVE it reached that line, via
    ``aclose_calls`` / ``aclose_raised``.
    """

    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.aclose_calls = 0
        self.aclose_raised = False
        self._running = False

    def __aiter__(self) -> "_ParkingReceiveStream":
        return self

    async def __anext__(self) -> Any:
        self.entered.set()
        self._running = True
        try:
            await asyncio.sleep(3600)
        finally:
            self._running = False
        raise AssertionError("unreachable: the parking stream never yields")

    async def aclose(self) -> None:
        self.aclose_calls += 1
        if self._running:
            self.aclose_raised = True
            raise RuntimeError("aclose(): asynchronous generator is already running")


class _SilentSession:
    """Duck-typed ``AsyncSession`` whose ``receive()`` never yields.

    One shared stream across calls: these nodes drive exactly one turn, and a
    stable handle is what ``_park_recv`` waits on to prove the consumer really
    suspended inside ``__anext__()``.
    """

    def __init__(self) -> None:
        self.stream = _ParkingReceiveStream()
        self.sent: List[Any] = []

    def receive(self) -> _ParkingReceiveStream:
        return self.stream

    async def send_realtime_input(self, **kwargs: Any) -> None:
        self.sent.append(kwargs)

    async def close(self) -> None:
        pass


class _FakeInlineData:
    def __init__(self, data: bytes) -> None:
        self.data = data


class _FakePart:
    def __init__(self, data: bytes) -> None:
        self.inline_data = _FakeInlineData(data)


class _FakeModelTurn:
    def __init__(self, parts: List[_FakePart]) -> None:
        self.parts = parts


class _FakeTranscription:
    def __init__(self, text: str) -> None:
        self.text = text


class _FakeServerContent:
    def __init__(
        self,
        *,
        output_transcription: Any = None,
        model_turn: Any = None,
        turn_complete: bool = False,
        interrupted: bool = False,
    ) -> None:
        self.output_transcription = output_transcription
        self.model_turn = model_turn
        self.turn_complete = turn_complete
        self.interrupted = interrupted


class _FakeLiveServerMessage:
    def __init__(self, server_content: Any) -> None:
        self.go_away = None
        self.server_content = server_content


class _ScriptedSession:
    """Duck-typed ``AsyncSession`` serving one scheduled turn per ``receive()``.

    Mirrors ``test_gemini_live_echo_safe.py``'s ``_FakeSession``: the real SDK's
    ``receive()`` generator yields one model turn then completes, so a FRESH
    generator per call is the faithful contract.
    """

    def __init__(self, turns: List[List[Any]]) -> None:
        self._turns = list(turns)
        self._turn_idx = 0
        self.sent: List[Any] = []

    def receive(self):
        if self._turn_idx < len(self._turns):
            msgs = self._turns[self._turn_idx]
            self._turn_idx += 1
        else:
            msgs = []

        async def _gen():
            for message in msgs:
                await asyncio.sleep(0)
                yield message

        return _gen()

    async def send_realtime_input(self, **kwargs: Any) -> None:
        self.sent.append(kwargs)

    async def close(self) -> None:
        pass


def _make_pcm(n_samples: int = 2400) -> bytes:
    """Silent PCM16 mono @24kHz."""
    return b"\x00\x00" * n_samples


def _clean_agent_turn(transcript: str = "hello there") -> List[_FakeLiveServerMessage]:
    """One clean agent turn: audio + transcript, then ``turn_complete``.

    The transcript rides along so the base ``_ensure_transcript`` short-circuits
    and no STT provider is reached.
    """
    return [
        _FakeLiveServerMessage(
            _FakeServerContent(
                output_transcription=_FakeTranscription(transcript),
                model_turn=_FakeModelTurn([_FakePart(_make_pcm(2400))]),
            )
        ),
        _FakeLiveServerMessage(_FakeServerContent(turn_complete=True)),
    ]


def _install_fake_client(
    monkeypatch,
    session: Any,
    *,
    enter_error: Optional[BaseException] = None,
    exit_error: Optional[BaseException] = None,
) -> None:
    """Fake ``genai.Client`` so the REAL ``connect()`` runs without credentials.

    ``enter_error`` fails the handshake BEFORE ``connect()`` returns (the
    ``gemini_live.py:260-261`` window). ``exit_error`` fails the SDK context
    manager on the way out — the one production path that reaches
    ``_session_lifetime``'s ``except Exception`` and stores ``_session_error``.
    """
    from google import genai  # noqa: PLC0415 — deferred like the adapter's own import

    class _CM:
        async def __aenter__(self):
            if enter_error is not None:
                raise enter_error
            return session

        async def __aexit__(self, *exc_info: Any) -> bool:
            if exit_error is not None:
                raise exit_error
            return False

    class _Live:
        def connect(self, *, model, config):
            return _CM()

    class _Aio:
        live = _Live()

    class _Client:
        def __init__(self, api_key=None):
            self.aio = _Aio()

    monkeypatch.setattr(genai, "Client", _Client)


# --------------------------------------------------------------------------- #
# recv_audio guard plumbing                                                   #
# --------------------------------------------------------------------------- #


class _Outcome(NamedTuple):
    """How a guarded ``recv_audio`` settled: a returned chunk, or a raise."""

    value: Optional[AudioChunk]
    error: Optional[BaseException]


def _guarded_recv(adapter: GeminiLiveAgentAdapter) -> "asyncio.Task[Any]":
    """Start ``recv_audio(timeout=30.0)`` under the mandated 5s outer guard.

    Every direct ``recv_audio`` call in this file goes through here, so a call
    that blinds-hangs fails the test at 5s instead of passing slowly at 30s.
    """
    return asyncio.ensure_future(
        asyncio.wait_for(
            adapter.recv_audio(timeout=_RECV_TIMEOUT_SECONDS),
            timeout=_RECV_GUARD_SECONDS,
        )
    )


async def _settle(task: "asyncio.Task[Any]") -> _Outcome:
    """Await a guarded ``recv_audio`` task and classify the result AFTERWARDS.

    Classification is deliberately post-await: resolving ``GeminiLiveRecvError``
    before the call settles would pre-empt the exact signal this file exists to
    produce on unmodified production code — a parked consumer hanging to its 5s
    guard (#718 AC5).
    """
    try:
        return _Outcome(value=await task, error=None)
    except BaseException as exc:  # noqa: BLE001 — classified by _assert_stream_ended
        return _Outcome(value=None, error=exc)


def _assert_stream_ended(outcome: _Outcome, *, when: str) -> BaseException:
    """Assert a settled ``recv_audio`` raised ``GeminiLiveRecvError``.

    Rejects each forbidden outcome with its own message, in the order that makes
    the red-before evidence legible: a returned (empty) chunk, then a hang, then
    the wrong type, then the base class instead of the named subclass.
    """
    assert outcome.error is not None, (
        f"{when}: recv_audio RETURNED {outcome.value!r} instead of raising. A dead "
        "Gemini Live session must surface an AgentStreamEndedError — an empty "
        "AudioChunk reads to the drain loop as a normal end-of-turn, which is the "
        "#718 bug wearing a different mask."
    )
    exc = outcome.error
    assert not isinstance(exc, asyncio.TimeoutError), (
        f"{when}: recv_audio stayed parked until the {_RECV_GUARD_SECONDS}s "
        f"asyncio.wait_for guard fired ({type(exc).__name__}). THAT IS the #718 "
        "starvation bug: the session is dead and nothing wakes the consumer."
    )
    assert isinstance(exc, AgentStreamEndedError), (
        f"{when}: expected an AgentStreamEndedError, got {type(exc).__name__}: {exc!r}"
    )
    assert "GeminiLive" in str(exc), (
        f"{when}: the error must name the adapter so the failure is attributable; "
        f"str() was {str(exc)!r}"
    )
    # Resolved dynamically: this symbol does not exist on unmodified main, and a
    # module-level import of it would error collection rather than fail the node.
    subclass = getattr(scenario_voice, "GeminiLiveRecvError", None)
    assert subclass is not None, (
        f"{when}: scenario.voice.GeminiLiveRecvError is not exported. The guard "
        "must raise a NAMED AgentStreamEndedError subclass — the PipecatRecvError "
        "precedent (#692) — not the base class."
    )
    assert issubclass(subclass, AgentStreamEndedError) and (
        subclass is not AgentStreamEndedError
    ), f"GeminiLiveRecvError must be a STRICT subclass of AgentStreamEndedError; got {subclass!r}"
    assert type(exc) is subclass, (
        f"{when}: expected exactly GeminiLiveRecvError, got {type(exc).__name__} — "
        "raising the base class leaves the adapter unattributable at the catch site."
    )
    return exc


async def _park_recv(
    adapter: GeminiLiveAgentAdapter, session: _SilentSession
) -> "asyncio.Task[Any]":
    """Start a guarded ``recv_audio`` and return once it is PROVABLY suspended.

    ``entered`` is set from inside ``__anext__`` before it parks, so awaiting it
    proves the consumer reached the suspension point rather than merely having
    been scheduled. Without that proof an entry-only guard passes these nodes and
    still ships the production hang (#718 AC3).
    """
    task = _guarded_recv(adapter)
    await asyncio.wait_for(session.stream.entered.wait(), timeout=2.0)
    await asyncio.sleep(0)
    assert not task.done(), (
        "recv_audio settled before it could park inside __anext__(); this node "
        "cannot discriminate an entry-only guard from a real one"
    )
    return task


async def _end_session_task(adapter: GeminiLiveAgentAdapter) -> None:
    """Release the REAL ``_session_lifetime`` body and let it run to completion.

    ``_session_lifetime`` parks on ``await self._shutdown.wait()`` INSIDE the SDK
    context manager, so setting that event is the only in-process way to reach the
    block's exit — and therefore the only way to reach its ``except Exception``
    handler (``:247-248``) through production code instead of fabricating
    ``_session_error`` by hand.

    Returns with the task DONE but a parked consumer's wake-up still queued:
    ``Event.set`` schedules the lifetime task's step ahead of this coroutine's
    resumption, and the task's own done-callbacks land behind it. That ordering is
    what lets a caller mirror ``disconnect()``'s ``:297-301`` state BEFORE the
    guard observes it.
    """
    assert adapter._shutdown is not None, "adapter was never connected"
    task = adapter._session_task
    assert task is not None, "adapter was never connected"
    adapter._shutdown.set()
    await asyncio.sleep(0)
    assert task.done(), (
        "the _session_lifetime task did not finish in one loop turn; the teardown "
        "ordering these nodes depend on no longer holds"
    )


async def _cancel_session_task(adapter: GeminiLiveAgentAdapter) -> None:
    """Cancel ``_session_lifetime`` — the death that leaves ``_session_error`` unset.

    ``CancelledError`` is a ``BaseException``, so ``except Exception:`` never sees
    it; the task ends done-and-cancelled with no recorded cause, while a consumer
    parked on ``__anext__()`` keeps waiting.
    """
    task = adapter._session_task
    assert task is not None, "adapter was never connected"
    task.cancel()
    await asyncio.sleep(0)
    if not task.done():
        with contextlib.suppress(asyncio.CancelledError):
            await task
    assert task.cancelled(), "expected the session task to end cancelled"


async def _quiet_disconnect(adapter: GeminiLiveAgentAdapter) -> None:
    """Best-effort teardown so a failing node cannot leak a live task into the next.

    ``CancelledError`` is suppressed alongside ``Exception`` because
    ``disconnect()`` awaits ``self._session_task`` under ``except
    (asyncio.TimeoutError, Exception)`` (``:290-296``) — which does not cover
    ``BaseException``, so a CANCELLED session task re-raises out of
    ``disconnect()``. Suppressing here is safe: this coroutine is never itself
    the cancellation target, so nothing real is being swallowed.
    """
    with contextlib.suppress(Exception, asyncio.CancelledError):
        await asyncio.wait_for(adapter.disconnect(), timeout=5.0)


def _by_name(spans):
    return {s.name: s for s in spans}


# --------------------------------------------------------------------------- #
# AC1 — a crashed session task surfaces, with the recorded cause chained       #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_crashed_session_task_surfaces_stream_ended(monkeypatch):
    """RED on main. The session task died with an exception recorded on
    ``_session_error``; the next ``recv_audio`` must raise GeminiLiveRecvError
    naming the adapter, chaining that EXACT object as ``__cause__`` — not return
    an empty chunk, not raise a bare RuntimeError, not time out.
    """
    session = _SilentSession()
    boom = ConnectionResetError("gemini live socket dropped")
    _install_fake_client(monkeypatch, session, exit_error=boom)

    adapter = GeminiLiveAgentAdapter(api_key=_FAKE_KEY)
    await adapter.connect()
    try:
        await _end_session_task(adapter)
        assert adapter._session_error is boom, (
            "precondition: _session_lifetime must have recorded the crash on "
            f"_session_error; got {adapter._session_error!r}"
        )

        outcome = await _settle(_guarded_recv(adapter))
        exc = _assert_stream_ended(outcome, when="after the session task crashed")
        assert exc.__cause__ is boom, (
            "the raised error must chain the EXACT exception stored on "
            f"_session_error, so the real cause survives; got {exc.__cause__!r}"
        )
    finally:
        await _quiet_disconnect(adapter)


# --------------------------------------------------------------------------- #
# AC2 — a task that died WITHOUT an exception is terminal too                  #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
@pytest.mark.parametrize("death", ["clean_return", "cancelled"])
async def test_clean_task_exit_surfaces_stream_ended(monkeypatch, death):
    """RED on main. ``_session_error`` is written only inside ``except
    Exception:``, so a clean return and a cancellation both leave it ``None``
    while the session is just as dead. Task-done must be the trigger.

    ``__cause__`` is legitimately ``None`` here and is deliberately NOT asserted
    non-None. The cancelled arm additionally pins the ``BaseException`` hazard: a
    guard that calls ``task.exception()`` on a cancelled task re-raises
    ``CancelledError`` out of ``recv_audio`` instead of the attributable error.
    """
    session = _SilentSession()
    _install_fake_client(monkeypatch, session)  # __aexit__ returns False → clean exit

    adapter = GeminiLiveAgentAdapter(api_key=_FAKE_KEY)
    await adapter.connect()
    try:
        if death == "clean_return":
            await _end_session_task(adapter)
            task = adapter._session_task
            assert task is not None and task.exception() is None, (
                "precondition: this arm needs a task that returned cleanly"
            )
        else:
            await _cancel_session_task(adapter)
        assert adapter._session_error is None, (
            "precondition: a non-Exception death must leave _session_error unset; "
            f"got {adapter._session_error!r}"
        )

        outcome = await _settle(_guarded_recv(adapter))
        _assert_stream_ended(
            outcome, when=f"after the session task ended without an exception ({death})"
        )
    finally:
        await _quiet_disconnect(adapter)


# --------------------------------------------------------------------------- #
# AC3 — the discriminating node: an ALREADY-PARKED consumer must wake          #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_parked_recv_audio_wakes_on_session_death(monkeypatch):
    """RED on main. THE node that separates a real fix from an entry-only check.

    The consumer is confirmed suspended inside ``await
    self._recv_iter.__anext__()`` BEFORE the session task is killed, so a guard
    that only inspects state on entry passes AC1 and AC2 and still fails here —
    which is exactly the production hang (#718; same lesson as #648).

    The kill must reach the parked call through the 5s guard, not by waiting out
    ``recv_audio``'s own 30s timeout.
    """
    session = _SilentSession()
    boom = ConnectionResetError("gemini live socket dropped mid-turn")
    _install_fake_client(monkeypatch, session, exit_error=boom)

    adapter = GeminiLiveAgentAdapter(api_key=_FAKE_KEY)
    await adapter.connect()
    try:
        parked = await _park_recv(adapter, session)
        assert adapter._recv_iter is session.stream, (
            "precondition: recv_audio must be parked on the session's own iterator"
        )

        # Only NOW does the session die — the whole point of this node.
        await _end_session_task(adapter)

        outcome = await _settle(parked)
        exc = _assert_stream_ended(
            outcome, when="for a consumer already parked in __anext__() when the session died"
        )
        assert exc.__cause__ is boom, (
            "the woken call must still chain the recorded cause; "
            f"got {exc.__cause__!r}"
        )
    finally:
        await _quiet_disconnect(adapter)


# --------------------------------------------------------------------------- #
# AC4a — the connect() window is untouched                                     #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_pre_connect_failure_propagates_unchanged(monkeypatch):
    """GREEN on main (regression lock). ``connect()`` already reads and raises
    ``_session_error`` at ``gemini_live.py:260-261``. A failure that lands BEFORE
    ``connect()`` returns must keep surfacing the ORIGINAL exception object — the
    new recv guard must neither swallow it, re-wrap it as an
    AgentStreamEndedError, nor double-raise.
    """
    boom = RuntimeError("gemini live handshake rejected")
    _install_fake_client(monkeypatch, _SilentSession(), enter_error=boom)

    adapter = GeminiLiveAgentAdapter(api_key=_FAKE_KEY)
    try:
        with pytest.raises(RuntimeError) as excinfo:
            await asyncio.wait_for(adapter.connect(), timeout=5.0)

        assert excinfo.value is boom, (
            "connect() must re-raise the EXACT recorded exception object; "
            f"got {excinfo.value!r}"
        )
        assert not isinstance(excinfo.value, AgentStreamEndedError), (
            "a pre-connect handshake failure is owned by connect(), not by the "
            f"recv guard; got {type(excinfo.value).__name__}"
        )
        assert adapter._session is None, "a failed connect() must leave no session"
    finally:
        await _quiet_disconnect(adapter)


# --------------------------------------------------------------------------- #
# AC4b — a parked consumer at each disconnect() teardown point                 #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_teardown_recv_iter_aclose_wakes_parked_recv(monkeypatch):
    """RED on main. The REAL ``disconnect()`` runs with a consumer parked.

    ``disconnect()`` calls ``self._recv_iter.aclose()`` (``:278``) on an iterator
    a consumer is actively awaiting, which raises ``aclose(): asynchronous
    generator is already running`` and is swallowed by ``except Exception: pass``.
    That swallow must not become the parked consumer's problem: the call must end
    in GeminiLiveRecvError, never a RuntimeError, an AttributeError from the
    half-torn-down adapter, an empty chunk, or a hang.
    """
    session = _SilentSession()
    _install_fake_client(monkeypatch, session)

    adapter = GeminiLiveAgentAdapter(api_key=_FAKE_KEY)
    await adapter.connect()
    try:
        parked = await _park_recv(adapter, session)

        await asyncio.wait_for(adapter.disconnect(), timeout=5.0)

        assert session.stream.aclose_calls == 1, (
            "precondition: disconnect() must have reached gemini_live.py:278; "
            f"aclose() was called {session.stream.aclose_calls} time(s)"
        )
        assert session.stream.aclose_raised, (
            "precondition: a PARKED consumer must make aclose() raise "
            "'already running' — otherwise this node is not covering :278's swallow"
        )

        outcome = await _settle(parked)
        _assert_stream_ended(
            outcome, when="after disconnect() closed the parked receive iterator (:278)"
        )
    finally:
        await _quiet_disconnect(adapter)


@pytest.mark.asyncio
async def test_teardown_session_task_cleared_wakes_parked_recv(monkeypatch):
    """RED on main. Teardown has advanced past ``self._session_task = None``
    (``:298``) — the line that nulls the guard's OWN trigger, and the one that
    actually strands a parked consumer.

    The teardown state is mirrored synchronously, before yielding, so the woken
    guard deterministically observes the post-``:298`` world rather than racing
    it. A guard that re-reads ``self._session_task`` after waking raises
    ``AttributeError: 'NoneType' object has no attribute 'done'``; one that polls
    it hangs. Both are failures here.
    """
    session = _SilentSession()
    _install_fake_client(monkeypatch, session)

    adapter = GeminiLiveAgentAdapter(api_key=_FAKE_KEY)
    await adapter.connect()
    try:
        parked = await _park_recv(adapter, session)
        await _end_session_task(adapter)  # :287 fires, :290 joins

        # gemini_live.py :285 / :297 / :298, applied without an intervening await.
        adapter._recv_iter = None
        adapter._session = None
        adapter._session_task = None

        outcome = await _settle(parked)
        _assert_stream_ended(
            outcome, when="with _session_task already cleared by teardown (:298)"
        )
    finally:
        await _quiet_disconnect(adapter)


@pytest.mark.asyncio
async def test_teardown_session_error_cleared_wakes_parked_recv(monkeypatch):
    """RED on main. Teardown has advanced past ``self._session_error = None``
    (``:301``): the session task is done and the recorded cause is gone.

    A guard keyed on ``_session_error`` being set — rather than on the task being
    done — strands the parked consumer here. ``__cause__`` is legitimately ``None``
    once the cause has been reset and is deliberately NOT asserted non-None.
    """
    session = _SilentSession()
    boom = ConnectionResetError("gemini live socket dropped")
    _install_fake_client(monkeypatch, session, exit_error=boom)

    adapter = GeminiLiveAgentAdapter(api_key=_FAKE_KEY)
    await adapter.connect()
    try:
        parked = await _park_recv(adapter, session)
        await _end_session_task(adapter)
        assert adapter._session_error is boom, (
            "precondition: the crash must have been recorded before teardown clears it"
        )

        # gemini_live.py :301, applied without an intervening await.
        adapter._session_error = None

        outcome = await _settle(parked)
        _assert_stream_ended(
            outcome, when="with _session_error already cleared by teardown (:301)"
        )
    finally:
        await _quiet_disconnect(adapter)


# --------------------------------------------------------------------------- #
# AC6 — a clean turn must NOT be reclassified as a dead stream                 #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_clean_turn_reports_terminal_chunk(monkeypatch, in_memory_spans):
    """GREEN on main (regression lock). Gemini's normal end-of-turn is an empty
    ``AudioChunk``, and the drain must keep reporting it as ``terminal_chunk`` —
    not ``stream_ended``. Pinning it on the gemini clean-turn boundary is what
    catches the new guard over-firing on a healthy session; without this node that
    regression goes green.
    """
    session = _ScriptedSession([_clean_agent_turn()])
    _install_fake_client(monkeypatch, session)

    adapter = GeminiLiveAgentAdapter(api_key=_FAKE_KEY)
    await adapter.connect()
    try:
        result = await asyncio.wait_for(
            drive_call(
                adapter, make_agent_input(user_audio=AudioChunk(data=_make_pcm(2400)))
            ),
            timeout=10.0,
        )
    finally:
        await _quiet_disconnect(adapter)

    assert isinstance(result, dict) and result.get("role") == "assistant", (
        f"a clean turn must still produce an assistant audio message; got {result!r}"
    )

    recv = _by_name(in_memory_spans.get_finished_spans())["voice.audio.receive"]
    assert attrs(recv)["voice.audio.terminated_reason"] == "terminal_chunk", (
        "a clean Gemini turn ends on the empty terminal chunk; reporting anything "
        "else (notably 'stream_ended') means the #718 guard fired on a healthy "
        f"session. Got {attrs(recv).get('voice.audio.terminated_reason')!r}"
    )
