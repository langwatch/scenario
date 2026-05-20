"""
Unit tests for InterruptionConfig and the interrupt() script step.

Covers:
    - InterruptionConfig defaults and sampling
    - interrupt(after_words=N) raises UnsupportedCapabilityError on adapters
      without streaming_transcripts (locked decision)
    - interrupt() event-driven path (no kwargs): agent(wait=False) + user(content)
    - interrupt(after_words=N) on streaming-capable adapter
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

    async def connect(self):
        pass
    async def disconnect(self):
        pass
    async def send_audio(self, chunk):
        pass
    async def recv_audio(self, timeout): return AudioChunk(data=b"")


class _StreamingAdapter(VoiceAgentAdapter):
    capabilities = AdapterCapabilities(streaming_transcripts=True)

    def __init__(self):
        super().__init__()
        # Simulated streaming transcript that crosses the N-word threshold quickly.
        self.streaming_transcript = "one two three four five"

    async def connect(self):
        pass
    async def disconnect(self):
        pass
    async def send_audio(self, chunk):
        pass
    async def recv_audio(self, timeout): return AudioChunk(data=b"")


class _FakeExecutor:
    def __init__(self, agents):
        self.agents = agents
        self.agent_calls: list[tuple[object, bool]] = []
        self.user_calls: list[str] = []

    async def agent(self, content=None, *, wait=True):
        self.agent_calls.append((content, wait))

    async def user(self, content=None):
        self.user_calls.append(content)  # type: ignore[arg-type,misc]


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
        await step(state)  # type: ignore[arg-type,misc]
    msg = str(exc.value).lower()
    assert "streaming_transcripts" in msg or "streaming transcripts" in msg
    assert "interrupt(content)" in msg


@pytest.mark.asyncio
async def test_interrupt_event_driven_triggers_agent_wait_false_then_user():
    """interrupt(content) with no kwargs runs agent(wait=False) then user(content).

    The actual barge-in timing happens inside executor.user() on adapters that
    support it; here we only assert the script step routes those two calls in
    order. No wall-clock assertion — timing is event-driven, not seconds-based.
    """
    adapter = _NoStreamingAdapter()
    state = _FakeState([adapter])
    await scenario.interrupt(content="wait that's wrong")(state)  # type: ignore[arg-type,misc]
    # agent(wait=False) then user("wait that's wrong")
    assert state._executor.agent_calls and state._executor.agent_calls[0][1] is False
    assert state._executor.user_calls == ["wait that's wrong"]


@pytest.mark.asyncio
async def test_interrupt_with_no_kwargs_is_valid():
    """interrupt(content) with neither after nor after_words is the new default.

    The wall-clock `after=` kwarg was removed in favor of event-driven timing.
    The script step should accept content alone without raising.
    """
    adapter = _NoStreamingAdapter()
    state = _FakeState([adapter])
    # Should not raise — empty kwargs is the event-driven default.
    await scenario.interrupt(content="x")(state)  # type: ignore[arg-type,misc]


@pytest.mark.asyncio
async def test_interrupt_after_words_works_when_streaming_supported():
    adapter = _StreamingAdapter()
    state = _FakeState([adapter])
    await scenario.interrupt(after_words=3, content="cut in")(state)  # type: ignore[arg-type,misc]
    # agent(wait=False) was called before content delivery
    assert state._executor.agent_calls and state._executor.agent_calls[0][1] is False
    assert state._executor.user_calls == ["cut in"]



def test_record_interrupt_user_segment_appends_segment_and_events():
    """Regression for #466 — interrupts must write a user segment, not just an event.

    Before the fix, ``_fire_user_interrupt`` only emitted a ``user_interrupt``
    timeline event; ``adapter.send_audio`` bypassed ``_AdapterRecorder``, so
    transports like Gemini Live produced a manifest with the interrupt event
    but no corresponding user segment.
    """
    import time as _time

    from scenario.scenario_executor import ScenarioExecutor
    from scenario.voice.audio_chunk import silent_chunk
    from scenario.voice.recording import VoiceRecording

    executor = ScenarioExecutor.__new__(ScenarioExecutor)
    executor._voice_recording = VoiceRecording()
    executor._voice_timeline = executor._voice_recording.timeline
    executor._voice_recording_started_at = _time.monotonic()
    executor._on_voice_event = None
    executor._on_audio_chunk = None

    chunk = silent_chunk(0.5)
    chunk.transcript = "Sorry, one more thing"
    user_start = _time.monotonic() - executor._voice_recording_started_at

    ScenarioExecutor._record_interrupt_user_segment(executor, chunk, user_start)

    segments = executor._voice_recording.segments
    timeline = executor._voice_timeline

    user_segments = [s for s in segments if s.speaker == "user"]
    assert len(user_segments) == 1, (
        f"Expected one user segment after interrupt; got {len(user_segments)} "
        f"(segments={segments})"
    )
    assert user_segments[0].transcript == "Sorry, one more thing"
    assert user_segments[0].audio == chunk.data
    assert user_segments[0].start_time == pytest.approx(user_start, abs=0.01)
    assert user_segments[0].end_time >= user_segments[0].start_time

    start_events = [e for e in timeline if e.type == "user_start_speaking"]
    stop_events = [e for e in timeline if e.type == "user_stop_speaking"]
    assert len(start_events) == 1
    assert len(stop_events) == 1
    assert start_events[0].time == pytest.approx(user_start, abs=0.01)
    assert stop_events[0].time >= start_events[0].time


@pytest.mark.asyncio
async def test_fire_user_interrupt_records_event_after_speaking_wait_not_before():
    """Regression for #467 — ``interrupt_time`` must be captured AFTER
    ``await speaking.wait()``, not before.

    Before the fix, ``_fire_user_interrupt`` snapshotted ``interrupt_time``
    at function entry. If the agent took N seconds to warm up
    (LLM/TTS cold start), the user_interrupt timeline event landed N seconds
    BEFORE the agent_start_speaking event the script intended to truncate —
    making downstream consumers think the interrupt fired during a
    not-yet-existent reply.

    This test reproduces the slow-warmup scenario: an adapter whose
    ``_agent_speaking_event`` only fires after a measurable delay. The
    recorded ``user_interrupt`` event must land at or after the delay,
    proving the post-wait re-capture is doing its job.
    """
    import asyncio
    import time as _time

    from scenario.scenario_executor import ScenarioExecutor
    from scenario.voice.recording import VoiceRecording

    # Build an adapter whose _agent_speaking_event becomes set after a
    # measurable warm-up delay. _fire_user_interrupt should observe the
    # delay and emit user_interrupt at the LATE timestamp.
    WARMUP_DELAY = 0.15  # seconds — well outside scheduler jitter

    class _SlowWarmupAdapter(VoiceAgentAdapter):
        capabilities = AdapterCapabilities(interruption=True)

        def __init__(self):
            super().__init__()
            self._speaking = asyncio.Event()
            self.interrupt_called = False
            self.sent_chunks: list[AudioChunk] = []

        @property
        def _agent_speaking_event(self) -> asyncio.Event:
            return self._speaking

        async def connect(self):
            pass
        async def disconnect(self):
            pass
        async def send_audio(self, chunk):
            self.sent_chunks.append(chunk)
        async def recv_audio(self, timeout):
            return AudioChunk(data=b"")
        async def interrupt(self):
            self.interrupt_called = True

    executor = ScenarioExecutor.__new__(ScenarioExecutor)
    executor._voice_recording = VoiceRecording()
    executor._voice_timeline = executor._voice_recording.timeline
    executor._voice_recording_started_at = _time.monotonic()
    executor._on_voice_event = None
    executor._on_audio_chunk = None
    # _fire_user_interrupt calls _clear_adapter_pending_messages once
    # audio is hand-delivered to the adapter — that path expects the
    # dict to be present.
    executor._pending_messages = {}

    adapter = _SlowWarmupAdapter()
    executor.agents = [adapter]

    # A trivial pending agent task so the early-out branch (pending_done)
    # doesn't fire. The task just sleeps so it's "in progress" when the
    # interrupt arrives.
    async def _fake_agent_turn():
        await asyncio.sleep(10.0)

    pending = asyncio.create_task(_fake_agent_turn())
    executor._pending_agent_task = pending

    # Warm-up simulation: schedule the speaking event to fire after the delay.
    async def _set_speaking_late():
        await asyncio.sleep(WARMUP_DELAY)
        adapter._speaking.set()
    warmup_task = asyncio.create_task(_set_speaking_late())

    # Build a real OpenAI-shaped message with audio — matches the
    # ChatCompletionMessageParam contract that ``extract_audio`` expects
    # (a dict with role + content parts, not a class with .audio).
    from scenario.voice.audio_chunk import silent_chunk
    from scenario.voice.messages import create_audio_message
    voiced = create_audio_message(silent_chunk(0.1), role="user")

    t_before = _time.monotonic() - executor._voice_recording_started_at
    await ScenarioExecutor._fire_user_interrupt(executor, voiced)
    t_after = _time.monotonic() - executor._voice_recording_started_at

    await warmup_task
    # pending will have been cancelled by _fire_user_interrupt's cleanup
    if not pending.done():
        pending.cancel()
        try:
            await pending
        except (asyncio.CancelledError, Exception):
            pass

    # Find the user_interrupt event and assert its time reflects the
    # POST-wait capture, not the entry capture. The post-wait timestamp
    # must be >= t_before + WARMUP_DELAY (we genuinely waited for the
    # warmup before sampling time again).
    interrupt_events = [e for e in executor._voice_timeline if e.type == "user_interrupt"]
    assert len(interrupt_events) == 1, (
        f"Expected exactly one user_interrupt event; got {len(interrupt_events)} "
        f"(timeline={[e.type for e in executor._voice_timeline]})"
    )
    event_time = interrupt_events[0].time

    # The crux of the regression: event_time must be >= t_before + WARMUP_DELAY
    # (with small tolerance for scheduler). If the eager-capture bug were
    # still live, event_time would be ~ t_before (no delay observed).
    assert event_time >= t_before + WARMUP_DELAY * 0.8, (
        f"user_interrupt event time {event_time:.3f}s landed before the "
        f"warm-up delay {WARMUP_DELAY:.3f}s — the eager-capture regression "
        f"would explain this. Expected post-wait re-capture to push event "
        f"time >= {t_before + WARMUP_DELAY * 0.8:.3f}s."
    )
    assert event_time <= t_after + 0.01

    # Sanity: the adapter got the native interrupt cue. The crux of
    # this regression is interrupt_time TIMING — audio plumbing is
    # covered by test_record_interrupt_user_segment_appends_segment_and_events.
    assert adapter.interrupt_called
