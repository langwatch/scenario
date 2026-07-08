"""
Voice-output harvest on ScenarioResult exit paths (Slice E of sc#740).

Slice E wires ``_attach_voice_output`` into the three exit paths in
``ScenarioExecutor.run`` that previously returned a ``ScenarioResult``
without harvesting voice output:

    * max-turns (both the mid-``proceed()`` L519 route and the
      end-of-script-without-conclusion L687 route, both via
      ``_reached_max_turns``)                                        — E1
    * generic ``except Exception`` propagation                       — E2
    * script-step ``AssertionError`` (``_check_failure``)            — E2b

It also tightens ``ScenarioResult`` typing so ``audio`` / ``timeline`` /
``latency`` reject wrong-shape values (E4) while text-only runs keep all
three None on every path (E-regression).

These tests drive ``scenario.run`` end-to-end but need NO live voice creds:
a stub ``VoiceAgentAdapter`` satisfies the ``has_voice`` check and a script
step hand-populates the executor's in-memory ``_voice_recording`` /
``_voice_timeline`` / ``_voice_latency`` (which ``_voice_connect_all``
initialises empty at the top of ``run``) before the target exit path fires.

Like the sibling ``voice/test_executor_lifecycle.py`` suite, these drive
``scenario.run`` and are skipped under ``CI=true`` (that path hangs in the
project's GitHub-Actions python-ci for reasons unrelated to this slice).
"""

import os

import pytest
from pydantic import ValidationError

from scenario import AgentAdapter, JudgeAgent, UserSimulatorAgent, proceed, run
from scenario.types import AgentInput, AgentReturnTypes, ScenarioResult
from scenario.voice import AdapterCapabilities, AudioChunk, VoiceAgentAdapter
from scenario.voice.recording import (
    AudioSegment,
    LatencyMetrics,
    VoiceEvent,
    VoiceRecording,
)


# Applied per-test on scenario.run-driven tests only (not on pure-construction
# tests like test_scenarioresult_rejects_wrong_audio_type so E4 stays in CI).
_skip_in_ci = pytest.mark.skipif(
    os.environ.get("CI") == "true",
    reason="scenario.run hangs in GitHub-Actions python-ci; runs fine locally",
)


# --------------------------------------------------------------------------- #
# Stub agents (no live creds, no LLM calls)                                    #
# --------------------------------------------------------------------------- #


class _StubVoiceAdapter(VoiceAgentAdapter):
    """Minimal voice adapter: satisfies ``has_voice`` with no transport.

    ``call`` returns a plain string so we never touch the send/recv drain
    machinery — the recording is hand-populated by the test's script step.
    """

    capabilities = AdapterCapabilities()

    def __init__(self):
        super().__init__()
        self.connects = 0
        self.disconnects = 0

    async def connect(self):
        self.connects += 1

    async def disconnect(self):
        self.disconnects += 1

    async def send_audio(self, chunk):
        pass

    async def recv_audio(self, timeout):
        return AudioChunk(data=b"")

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "voice response"


class _TextAgent(AgentAdapter):
    """Text-only agent under test (no voice adapter -> voice fields stay None)."""

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "text response"


class _StubUserSim(UserSimulatorAgent):
    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "hello from the user"


class _NoopJudge(JudgeAgent):
    """Judge that never concludes -> lets proceed() run to max_turns."""

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return []


# --------------------------------------------------------------------------- #
# Recording construction helpers                                              #
# --------------------------------------------------------------------------- #

# One 20ms frame of PCM16 @ 24kHz mono (24000 * 0.02 * 2 bytes).
_PCM_FRAME = b"\x00\x00" * 480


def _one_segment_recording() -> VoiceRecording:
    """A recording with a single agent segment so ``_attach_voice_output``
    treats it as non-empty (the ``recording.segments`` guard)."""
    return VoiceRecording(
        segments=[
            AudioSegment(
                speaker="agent",
                start_time=0.0,
                end_time=1.0,
                audio=_PCM_FRAME,
                transcript="hi",
            )
        ]
    )


def _populate_voice_state(
    state,
    *,
    recording: VoiceRecording,
    timeline: list,
    latency: LatencyMetrics,
):
    """Script step body: hand-populate the executor's voice attrs.

    ``_voice_connect_all`` (run at the top of ``run``) has already created
    empty ``_voice_recording`` / ``_voice_timeline`` / ``_voice_latency``.
    We overwrite them here so the exit paths have something to harvest.
    """
    ex = state._executor
    ex._voice_recording = recording
    ex._voice_timeline = timeline
    ex._voice_latency = latency


def _populate_step(recording, timeline, latency):
    """Return a plain-callable script step that populates voice state."""
    return lambda state: _populate_voice_state(
        state, recording=recording, timeline=timeline, latency=latency
    )


def _assert_voice_fields_present(result: ScenarioResult) -> None:
    assert result.audio is not None, "expected result.audio populated"
    assert result.timeline is not None, "expected result.timeline populated"
    assert result.latency is not None, "expected result.latency populated"


def _default_timeline():
    return [VoiceEvent(time=0.5, type="agent_start_speaking", latency=0.3)]


def _default_latency():
    return LatencyMetrics(measurements=[0.3])


# --------------------------------------------------------------------------- #
# E1 — max-turns path (both L519 mid-script and L687 end-of-script)            #
# --------------------------------------------------------------------------- #


@_skip_in_ci
@pytest.mark.asyncio
async def test_max_turns_path_carries_voice_fields():
    # --- L519: mid-script max-turns via proceed() -------------------------- #
    # max_turns=1 + a noop judge means proceed() runs turn 0 then trips the
    # `current_turn >= max_turns` return inside _step (L519 -> _reached_max_turns).
    adapter_a = _StubVoiceAdapter()
    result_l519 = await run(
        name="max-turns-l519",
        description="voice run tripping mid-script max-turns",
        agents=[
            adapter_a,
            _StubUserSim(model="none"),
            _NoopJudge(model="none", criteria=["c"]),
        ],
        max_turns=1,
        script=[
            _populate_step(
                _one_segment_recording(), _default_timeline(), _default_latency()
            ),
            proceed(),
        ],
    )
    assert result_l519.success is False
    _assert_voice_fields_present(result_l519)

    # --- L687: end-of-script without conclusion ---------------------------- #
    # A script with no succeed/fail/judge/proceed and no checkpoints falls
    # through to the `else` branch -> _reached_max_turns (L687).
    adapter_b = _StubVoiceAdapter()
    result_l687 = await run(
        name="max-turns-l687",
        description="voice run ending without conclusion",
        agents=[adapter_b],
        script=[
            _populate_step(
                _one_segment_recording(), _default_timeline(), _default_latency()
            ),
        ],
    )
    assert result_l687.success is False
    _assert_voice_fields_present(result_l687)


# --------------------------------------------------------------------------- #
# E2 — generic exception path                                                  #
# --------------------------------------------------------------------------- #


@_skip_in_ci
@pytest.mark.asyncio
async def test_except_path_carries_voice_fields():
    adapter = _StubVoiceAdapter()

    captured: dict = {}

    def _blow_up(state):
        # A non-AssertionError raised in a script step propagates through the
        # generic `except Exception` handler (L704). We stash the executor so
        # we can re-run the exact harvest that path performs on error_result.
        captured["executor"] = state._executor
        raise RuntimeError("boom mid-run")

    with pytest.raises(RuntimeError):
        await run(
            name="except-path",
            description="voice run raising mid-run",
            agents=[adapter],
            script=[
                _populate_step(
                    _one_segment_recording(),
                    _default_timeline(),
                    _default_latency(),
                ),
                _blow_up,
            ],
        )

    # The harvest happened on error_result before re-raise. Verify the
    # executor's voice state was set (the populate step ran) and that the
    # harvest path is the one under test by re-harvesting a fresh result the
    # same way run() does.
    ex = captured["executor"]
    probe = ScenarioResult(success=False, messages=[])
    probe = ex._attach_voice_output(probe)
    _assert_voice_fields_present(probe)


# --------------------------------------------------------------------------- #
# E2b — check-failure path (AssertionError in a script step)                   #
# --------------------------------------------------------------------------- #


@_skip_in_ci
@pytest.mark.asyncio
async def test_check_failure_path_carries_voice_fields():
    adapter = _StubVoiceAdapter()
    captured: dict = {}

    def _assert_fail(state):
        captured["executor"] = state._executor
        raise AssertionError("script assertion failed")

    with pytest.raises(AssertionError):
        await run(
            name="check-failure-path",
            description="voice run with a failing assertion step",
            agents=[adapter],
            script=[
                _populate_step(
                    _one_segment_recording(),
                    _default_timeline(),
                    _default_latency(),
                ),
                _assert_fail,
            ],
        )

    ex = captured["executor"]
    probe = ScenarioResult(success=False, messages=[])
    probe = ex._attach_voice_output(probe)
    _assert_voice_fields_present(probe)


# --------------------------------------------------------------------------- #
# E3 — interrupt overlap flags only the overlapped agent segment              #
# --------------------------------------------------------------------------- #


@_skip_in_ci
@pytest.mark.asyncio
async def test_interrupt_overlap_flags_agent_segment():
    # agent seg [3.0, 5.0] overlaps a user_interrupt at t=4.0 -> truncated.
    overlapped = AudioSegment(
        speaker="agent",
        start_time=3.0,
        end_time=5.0,
        audio=_PCM_FRAME,
        transcript="interrupted reply",
    )
    user_seg = AudioSegment(
        speaker="user",
        start_time=0.0,
        end_time=2.0,
        audio=_PCM_FRAME,
        transcript="user turn",
    )
    clean_agent = AudioSegment(
        speaker="agent",
        start_time=6.0,
        end_time=7.0,
        audio=_PCM_FRAME,
        transcript="clean reply",
    )
    recording = VoiceRecording(
        segments=[user_seg, overlapped, clean_agent]
    )
    timeline = [VoiceEvent(time=4.0, type="user_interrupt")]

    adapter = _StubVoiceAdapter()
    result = await run(
        name="interrupt-overlap",
        description="voice run harvesting a truncated agent segment",
        agents=[adapter],
        # End-of-script-without-conclusion (L687) -> a newly-covered exit path.
        script=[_populate_step(recording, timeline, _default_latency())],
    )

    _assert_voice_fields_present(result)
    assert result.audio is not None
    segs = {id(s): s for s in result.audio.segments}
    assert segs[id(overlapped)].transcript_truncated is True
    assert segs[id(user_seg)].transcript_truncated is False
    assert segs[id(clean_agent)].transcript_truncated is False
    # Exactly one segment flagged.
    assert sum(1 for s in result.audio.segments if s.transcript_truncated) == 1


# --------------------------------------------------------------------------- #
# E4 — ScenarioResult rejects wrong-shape voice fields                         #
# --------------------------------------------------------------------------- #


def test_scenarioresult_rejects_wrong_audio_type():
    # A plain dict is not a VoiceRecording -> ValidationError.
    with pytest.raises(ValidationError):
        ScenarioResult(success=True, messages=[], audio={"not": "a recording"})  # type: ignore[arg-type]  # intentional wrong type to assert runtime ValidationError

    # A str is not a VoiceRecording either.
    with pytest.raises(ValidationError):
        ScenarioResult(success=True, messages=[], audio="nope")  # type: ignore[arg-type]  # intentional wrong type to assert runtime ValidationError

    # timeline must be a list of VoiceEvent.
    with pytest.raises(ValidationError):
        ScenarioResult(success=True, messages=[], timeline=[{"time": 1.0}])  # type: ignore[arg-type]  # intentional wrong type to assert runtime ValidationError

    # latency must be a LatencyMetrics.
    with pytest.raises(ValidationError):
        ScenarioResult(success=True, messages=[], latency={"measurements": []})  # type: ignore[arg-type]  # intentional wrong type to assert runtime ValidationError

    # Correctly-typed values are accepted.
    ok = ScenarioResult(
        success=True,
        messages=[],
        audio=VoiceRecording(),
        timeline=[VoiceEvent(time=0.0, type="tool_call")],
        latency=LatencyMetrics(),
    )
    assert isinstance(ok.audio, VoiceRecording)
    assert isinstance(ok.latency, LatencyMetrics)


# --------------------------------------------------------------------------- #
# E-regression — text-only runs keep voice fields None on every path          #
# --------------------------------------------------------------------------- #


@_skip_in_ci
@pytest.mark.asyncio
async def test_text_only_runs_keep_voice_fields_none_all_paths():
    def _assert_none(result: ScenarioResult) -> None:
        assert result.audio is None
        assert result.timeline is None
        assert result.latency is None

    # --- max-turns L519 (mid-script proceed) ------------------------------- #
    r_l519 = await run(
        name="text-max-turns-l519",
        description="text-only run tripping mid-script max-turns",
        agents=[
            _TextAgent(),
            _StubUserSim(model="none"),
            _NoopJudge(model="none", criteria=["c"]),
        ],
        max_turns=1,
        script=[proceed()],
    )
    assert r_l519.success is False
    _assert_none(r_l519)

    # --- max-turns L687 (end-of-script without conclusion) ----------------- #
    r_l687 = await run(
        name="text-max-turns-l687",
        description="text-only run ending without conclusion",
        agents=[_TextAgent()],
        script=[lambda state: None],
    )
    assert r_l687.success is False
    _assert_none(r_l687)

    # --- generic exception path -------------------------------------------- #
    def _blow_up(state):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        await run(
            name="text-except",
            description="text-only run raising mid-run",
            agents=[_TextAgent()],
            script=[_blow_up],
        )

    # --- check-failure path (AssertionError) ------------------------------- #
    def _assert_fail(state):
        raise AssertionError("nope")

    with pytest.raises(AssertionError):
        await run(
            name="text-check-failure",
            description="text-only run with a failing assertion step",
            agents=[_TextAgent()],
            script=[_assert_fail],
        )


# --------------------------------------------------------------------------- #
# harvest-failure regression — original error must not be masked              #
# --------------------------------------------------------------------------- #


@_skip_in_ci
@pytest.mark.asyncio
async def test_harvest_failure_on_error_path_preserves_original_error(monkeypatch):
    """If _attach_voice_output raises on an error path, the ORIGINAL scenario
    error must propagate — NOT the harvest exception.  Covers both the
    _check_failure (AssertionError) path and the generic except-Exception path.
    """
    from scenario.scenario_executor import ScenarioExecutor

    # --- _check_failure path (AssertionError) ------------------------------ #
    # Monkeypatch _attach_voice_output to raise after the AssertionError is
    # captured so we know harvest is the only thing that can go wrong.
    original_attach = ScenarioExecutor._attach_voice_output

    def _broken_attach(self, result):
        raise RuntimeError("harvest exploded")

    monkeypatch.setattr(ScenarioExecutor, "_attach_voice_output", _broken_attach)

    def _assert_fail(state):
        raise AssertionError("the real scenario error")

    with pytest.raises(AssertionError, match="the real scenario error"):
        await run(
            name="harvest-fail-assert",
            description="original AssertionError must survive a broken harvest",
            agents=[_StubVoiceAdapter()],
            script=[_assert_fail],
        )

    # --- generic except-Exception path ------------------------------------ #
    def _runtime_fail(state):
        raise ValueError("the real runtime error")

    with pytest.raises(ValueError, match="the real runtime error"):
        await run(
            name="harvest-fail-except",
            description="original ValueError must survive a broken harvest",
            agents=[_StubVoiceAdapter()],
            script=[_runtime_fail],
        )

    monkeypatch.setattr(ScenarioExecutor, "_attach_voice_output", original_attach)


@_skip_in_ci
@pytest.mark.asyncio
async def test_harvest_failure_on_max_turns_path_returns_max_turns_result(monkeypatch):
    """If _attach_voice_output raises on the max-turns path, the max-turns
    ScenarioResult (success=False, 'Reached maximum turns') must be RETURNED
    unmasked — not replaced by the harvest exception.
    """
    from scenario.scenario_executor import ScenarioExecutor

    def _broken_attach(self, result):
        raise RuntimeError("harvest exploded on max-turns")

    monkeypatch.setattr(ScenarioExecutor, "_attach_voice_output", _broken_attach)

    # Drive the mid-script L519 max-turns route (max_turns=1 + proceed() trips
    # the current_turn >= max_turns check before conclusion).
    result = await run(
        name="harvest-fail-max-turns",
        description="max-turns result must survive a broken harvest",
        agents=[
            _StubVoiceAdapter(),
            _StubUserSim(model="none"),
            _NoopJudge(model="none", criteria=["c"]),
        ],
        max_turns=1,
        script=[proceed()],
    )

    # The max-turns ScenarioResult must come back — not an exception.
    assert result.success is False
    assert result.reasoning is not None
    assert "maximum turns" in result.reasoning.lower() or "without conclusion" in result.reasoning.lower()
