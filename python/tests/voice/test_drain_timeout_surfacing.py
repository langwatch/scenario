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
"""

from __future__ import annotations

import asyncio

import pytest

from scenario.voice import (
    AdapterCapabilities,
    AudioChunk,
    VoiceAgentAdapter,
)

# A deliberately non-default value so the assertion proves the *configured*
# number is surfaced, not a coincidental default.
_SENTINEL_TIMEOUT = 0.05


class _FirstChunkTimeoutAdapter(VoiceAgentAdapter):
    """Real adapter whose transport never yields a first chunk.

    Overrides only the four abstract transport hooks; the drain logic under
    test is inherited from ``VoiceAgentAdapter`` unchanged.
    """

    capabilities = AdapterCapabilities(
        streaming_transcripts=True,
        native_vad=True,
        dtmf=False,
        input_formats=["pcm16/24000"],
        output_formats=["pcm16/24000"],
    )

    async def connect(self) -> None:  # pragma: no cover - trivial
        pass

    async def disconnect(self) -> None:  # pragma: no cover - trivial
        pass

    async def send_audio(self, chunk: AudioChunk) -> None:  # pragma: no cover
        pass

    async def recv_audio(self, timeout: float) -> AudioChunk:
        # Mirror what `asyncio.wait_for(queue.get(), timeout)` raises in
        # pipecat.PipecatAgentAdapter.recv_audio when no agent audio arrives:
        # a bare, message-less TimeoutError.
        raise asyncio.TimeoutError()


@pytest.mark.asyncio
async def test_first_chunk_timeout_is_attributable():
    """The error escaping the drain on a first-chunk timeout must be
    informative — non-empty, naming the first-chunk timeout, and quoting the
    configured ``response_timeout`` value — so an operator can attribute it.

    RED against current code: the first-chunk ``recv_audio`` call is unwrapped,
    so a bare ``asyncio.TimeoutError`` (``str() == ""``) escapes verbatim with
    no context.
    """
    adapter = _FirstChunkTimeoutAdapter()
    adapter.response_timeout = _SENTINEL_TIMEOUT

    with pytest.raises(asyncio.TimeoutError) as excinfo:
        await adapter._drain_agent_response()

    message = str(excinfo.value)

    # 1. Body must never be blank — the whole point of the diagnostic slice.
    assert message.strip(), (
        "first-chunk timeout escaped with a blank body — operators get no "
        f"signal; got: {message!r}"
    )

    # 2. Must distinguish the first-chunk timeout from a tail-silence cutoff.
    assert "first" in message.lower(), (
        "timeout message must name the *first-chunk* wait so it is "
        f"distinguishable from a tail-silence cutoff; got: {message!r}"
    )

    # 3. Must surface the configured timeout value so the operator can judge
    #    whether the budget was simply too short for a real STT+LLM+TTS turn.
    assert str(_SENTINEL_TIMEOUT) in message, (
        "timeout message must quote the configured response_timeout value; "
        f"got: {message!r}"
    )
