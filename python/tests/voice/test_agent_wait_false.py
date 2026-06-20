"""
Unit tests for the ``agent(wait=False)`` async primitive (§4.4 L369-382).

Verifies the concurrency contract: control returns before the agent turn
finishes, and subsequent blocking steps await the pending turn.

These tests drive ``scenario.run`` end-to-end with no external services
(~1s total). The earlier ``skipif(CI)`` guard masked an unrealistic fixture:
``_SlowAdapter`` returned audio on *every* ``recv_audio`` call, so the base
``_drain_agent_response`` loop never tail-silenced and ran to
``response_max_duration`` (~90s of wall-clock for this cadence) — tripping
CI's 60s timeout while squeaking under it on faster local machines. The
fixture now emits one chunk then an end-of-turn empty chunk, the contract
every real adapter honors, so the turn terminates promptly.
"""

import asyncio

import pytest

import scenario
from scenario.voice import AdapterCapabilities, AudioChunk, VoiceAgentAdapter


class _SlowAdapter(VoiceAgentAdapter):
    capabilities = AdapterCapabilities()

    def __init__(self, recv_delay: float = 0.3):
        super().__init__()
        self.recv_delay = recv_delay
        self.recv_returned_at: float | None = None
        self._spoke: bool = False

    async def connect(self):
        pass

    async def disconnect(self):
        pass

    async def send_audio(self, chunk):
        pass

    async def recv_audio(self, timeout):
        # Speak one slow chunk, then signal end-of-turn with an empty chunk so
        # the base ``_drain_agent_response`` loop terminates on tail silence —
        # the contract every real adapter honors. Returning audio on *every*
        # call (the previous behavior) never tail-silences, so the drain runs
        # to ``response_max_duration`` (~90s of wall-clock for this cadence),
        # which is what wedged the turn in CI.
        if self._spoke:
            return AudioChunk(data=b"")
        self._spoke = True
        await asyncio.sleep(self.recv_delay)
        self.recv_returned_at = asyncio.get_event_loop().time()
        return AudioChunk(data=b"\x00\x00" * 2400)


class _CannedUser(scenario.AgentAdapter):
    role = scenario.AgentRole.USER

    async def call(self, input):
        return "hi"


@pytest.mark.timeout(30)
@pytest.mark.asyncio
async def test_agent_wait_false_returns_before_turn_finishes():
    """A wait=False agent step must not block until the slow recv completes.

    The ``timeout`` guards the regression this fixture once caused: an adapter
    that never tail-silences makes the drain run to ``response_max_duration``
    (~90s), so a stuck turn fails fast and loud here instead of wedging CI.
    """
    slow = _SlowAdapter(recv_delay=0.3)

    returned_at: float | None = None

    def _stamp(state):
        nonlocal returned_at
        returned_at = asyncio.get_event_loop().time()

    await scenario.run(
        name="wait-false-non-blocking",
        description="control returns before agent finishes speaking",
        agents=[slow, _CannedUser()],
        script=[
            scenario.user(),
            scenario.agent(wait=False),
            _stamp,  # runs immediately, before slow.recv_audio completes
            scenario.sleep(0.5),  # now wait long enough for recv to finish
            scenario.succeed("done"),
        ],
    )

    # The stamp must have fired BEFORE the slow recv_audio returned.
    assert returned_at is not None and slow.recv_returned_at is not None
    assert returned_at < slow.recv_returned_at, (
        f"stamp fired at {returned_at} but recv didn't complete until "
        f"{slow.recv_returned_at}"
    )


@pytest.mark.asyncio
async def test_double_wait_false_in_flight_raises():
    """Scheduling a second wait=False turn while one is in flight must raise."""
    slow = _SlowAdapter(recv_delay=0.5)
    with pytest.raises(RuntimeError, match="already in flight"):
        await scenario.run(
            name="double wait-false",
            description="two wait=False in a row without a drain",
            agents=[slow, _CannedUser()],
            script=[
                scenario.user(),
                scenario.agent(wait=False),
                scenario.agent(wait=False),
                scenario.succeed("done"),
            ],
        )


@pytest.mark.asyncio
async def test_no_accent_effect_exists():
    # Design prohibition (§4.5 L536-544): accents are handled via TTS voice
    # selection, not a post-processing effect.
    from scenario.voice import effects as fx

    assert not hasattr(fx, "accent")
