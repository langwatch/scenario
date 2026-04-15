"""
Unit tests for InterruptionConfig and the interrupt() script step.

Covers:
    - InterruptionConfig defaults and sampling
    - interrupt(after_words=N) raises UnsupportedCapabilityError on adapters
      without streaming_transcripts (locked decision)
    - interrupt() argument validation
"""

import random

import pytest

import scenario
from scenario.voice import (
    AdapterCapabilities,
    AudioChunk,
    InterruptionConfig,
    UnsupportedCapabilityError,
    VoiceAgentAdapter,
)


class _NoStreamingAdapter(VoiceAgentAdapter):
    capabilities = AdapterCapabilities(streaming_transcripts=False)

    async def connect(self): ...
    async def disconnect(self): ...
    async def send_audio(self, chunk): ...
    async def recv_audio(self, timeout): return AudioChunk(data=b"")


class _StreamingAdapter(VoiceAgentAdapter):
    capabilities = AdapterCapabilities(streaming_transcripts=True)

    def __init__(self):
        # Simulated streaming transcript that crosses the N-word threshold quickly.
        self.streaming_transcript = "one two three four five"

    async def connect(self): ...
    async def disconnect(self): ...
    async def send_audio(self, chunk): ...
    async def recv_audio(self, timeout): return AudioChunk(data=b"")


class _FakeExecutor:
    def __init__(self, agents):
        self.agents = agents
        self.agent_calls: list[tuple[object, bool]] = []
        self.user_calls: list[str] = []

    async def agent(self, content=None, *, wait=True):
        self.agent_calls.append((content, wait))

    async def user(self, content=None):
        self.user_calls.append(content)


class _FakeState:
    def __init__(self, agents):
        self.agents = agents
        self.messages = []
        self._executor = _FakeExecutor(agents)


# ------------------------------------------------------------ InterruptionConfig

def test_interruption_config_defaults():
    cfg = InterruptionConfig()
    assert cfg.probability == 0.3
    assert cfg.delay_range == (0.5, 3.0)
    assert cfg.strategy == "random_phrase"
    assert len(cfg.phrases) > 0


def test_interruption_config_sample_delay_within_range():
    cfg = InterruptionConfig(delay_range=(0.1, 0.2))
    rng = random.Random(0)
    for _ in range(20):
        d = cfg.sample_delay(rng)
        assert 0.1 <= d <= 0.2


def test_interruption_config_random_phrase_from_list():
    cfg = InterruptionConfig(phrases=("only_one",))
    assert cfg.pick_random_phrase() == "only_one"


def test_interruption_config_should_interrupt_respects_probability():
    cfg = InterruptionConfig(probability=0.0)
    rng = random.Random(0)
    assert all(not cfg.should_interrupt(rng) for _ in range(100))
    cfg = InterruptionConfig(probability=1.0)
    assert all(cfg.should_interrupt(rng) for _ in range(100))


# ------------------------------------------------------------- interrupt() step

@pytest.mark.asyncio
async def test_interrupt_after_words_raises_when_adapter_lacks_streaming():
    adapter = _NoStreamingAdapter()
    state = _FakeState([adapter])
    step = scenario.interrupt(after_words=5, content="cut in")
    with pytest.raises(UnsupportedCapabilityError) as exc:
        await step(state)
    msg = str(exc.value).lower()
    assert "streaming_transcripts" in msg or "streaming transcripts" in msg
    assert "interrupt(after=seconds)" in msg or "after=seconds" in msg


@pytest.mark.asyncio
async def test_interrupt_after_seconds_triggers_agent_wait_false_then_user():
    # Use a 200ms sleep with generous slack so CI scheduler jitter doesn't flake.
    import time
    adapter = _NoStreamingAdapter()
    state = _FakeState([adapter])
    step = scenario.interrupt(after=0.2, content="wait that's wrong")
    t0 = time.monotonic()
    await step(state)
    elapsed = time.monotonic() - t0
    assert elapsed >= 0.15
    # agent(wait=False) then user("wait that's wrong")
    assert state._executor.agent_calls and state._executor.agent_calls[0][1] is False
    assert state._executor.user_calls == ["wait that's wrong"]


def test_interrupt_requires_after_or_after_words():
    with pytest.raises(ValueError):
        scenario.interrupt(content="x")


def test_interrupt_rejects_both_after_and_after_words():
    with pytest.raises(ValueError):
        scenario.interrupt(after=1.0, after_words=5, content="x")


@pytest.mark.asyncio
async def test_interrupt_after_words_works_when_streaming_supported():
    adapter = _StreamingAdapter()
    state = _FakeState([adapter])
    await scenario.interrupt(after_words=3, content="cut in")(state)
    # agent(wait=False) was called before content delivery
    assert state._executor.agent_calls and state._executor.agent_calls[0][1] is False
    assert state._executor.user_calls == ["cut in"]
