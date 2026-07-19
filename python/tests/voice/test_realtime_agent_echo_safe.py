"""
AC7 — Echo-safe transcript surfacing test for OpenAIRealtimeAgentAdapter.

Verifies that a free-running voiced UserSimulatorAgent does NOT echo the
realtime agent's spoken question back as the candidate's answer (AC4), and
that the transcript lands in result.messages as a text part (AC2/AC5).

Mock strategy (AC7):
- The OpenAI Realtime WebSocket is replaced by a scripted queue-based mock
  so no real API connection is needed. Only the WS transport and
  litellm.completion are mocked; _strip_audio_content, reverse_roles, and
  the adapter's transcript-surfacing path run for real.
- litellm.completion is stubbed to a "parrot" that returns the last user-role
  message it sees. This makes the echo trivially detectable (Jaccard > 0.8)
  in the naive/pre-fix case, and the reframe must produce Jaccard < 0.8.

AC4 contract:
  Q = the agent's spoken question (from the mock transcript event)
  U = the user-sim's generated reply (from the parrot stub via real _generate_text)
  post-fix:     jaccard(U, Q) < 0.8    (reframe breaks verbatim echo)
  pre-fix/naive: jaccard(U, Q) > 0.8   (no reframe → parrot echoes Q)

AC11 contract: "scenario_origin" must not appear in result.messages JSON.
"""

from __future__ import annotations

import asyncio
import base64
import json
import wave
from io import BytesIO
from typing import Any, List
from unittest.mock import patch

from litellm.files.main import ModelResponse as _LiteLLMModelResponse

import pytest

import scenario
from scenario.config import ScenarioConfig
from scenario.voice.adapters.openai_realtime import OpenAIRealtimeAgentAdapter
from scenario.voice.testing import drive_call
from scenario.user_simulator_agent import UserSimulatorAgent


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

QUESTION = "what was your role on the payments team"


def _make_pcm(n_samples: int = 2400) -> bytes:
    """Minimal silent PCM16 mono @ 24 kHz."""
    return b"\x00\x00" * n_samples


def _make_wav(n_samples: int = 2400) -> bytes:
    """WAV container wrapping silent PCM16 @ 24 kHz."""
    buf = BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x00\x00" * n_samples)
    return buf.getvalue()


def _b64_pcm(n_samples: int = 480) -> str:
    return base64.b64encode(_make_pcm(n_samples)).decode()


def jaccard(a: str, b: str) -> float:
    wa = set(a.lower().split())
    wb = set(b.lower().split())
    if not wa and not wb:
        return 1.0
    return len(wa & wb) / len(wa | wb)


# ---------------------------------------------------------------------------
# Mock WebSocket
# ---------------------------------------------------------------------------

class _MockWS:
    """Queue-backed WebSocket mock.

    Calls to ``send()`` are recorded. Calls to ``recv()`` return events from
    the pre-loaded queue in order. Once the queue is exhausted, ``recv()``
    raises asyncio.TimeoutError (simulates tail silence / no more events).

    For multi-turn tests, use ``_CommandDrivenMockWS`` instead which feeds
    events only after a ``response.create`` command is sent.
    """

    def __init__(self, events: List[str]) -> None:
        self._events = list(events)
        self._idx = 0
        self.sent: List[Any] = []
        # Observable disconnect: set True by close() so the wrapper-level smoke
        # test can assert the real disconnect() reached the transport.
        self.closed = False

    async def send(self, msg: Any) -> None:
        self.sent.append(msg)

    async def recv(self) -> str:
        if self._idx >= len(self._events):
            # No more events → simulate tail silence.
            await asyncio.sleep(0)
            raise asyncio.TimeoutError("mock WS: no more events")
        evt = self._events[self._idx]
        self._idx += 1
        return evt

    async def close(self) -> None:
        self.closed = True


class _CommandDrivenMockWS:
    """Command-driven WebSocket mock for multi-turn tests.

    Emits a pre-loaded response sequence for each ``response.create`` command
    received. This matches the real realtime API's behavior: events are only
    emitted after a command is sent, preventing premature event consumption
    across turn boundaries.
    """

    def __init__(self, turn_sequences: List[List[str]]) -> None:
        """
        Args:
            turn_sequences: A list of event sequences. Each sequence is
                emitted in full after one ``response.create`` command.
        """
        self._turn_sequences = list(turn_sequences)
        self._current_turn: List[str] = []
        self._turn_idx = 0
        self._event_idx = 0
        self._recv_queue: asyncio.Queue = asyncio.Queue()
        self.sent: List[Any] = []

    async def send(self, msg: Any) -> None:
        self.sent.append(msg)
        # When a response.create command is received, queue the next sequence.
        try:
            parsed = json.loads(msg) if isinstance(msg, str) else {}
        except Exception:
            parsed = {}
        if parsed.get("type") == "response.create":
            if self._turn_idx < len(self._turn_sequences):
                for evt in self._turn_sequences[self._turn_idx]:
                    await self._recv_queue.put(evt)
                self._turn_idx += 1

    async def recv(self) -> str:
        try:
            return await asyncio.wait_for(self._recv_queue.get(), timeout=0.5)
        except asyncio.TimeoutError:
            raise asyncio.TimeoutError("mock WS: no more events in queue")

    async def close(self) -> None:
        pass


def _agent_event_sequence(question: str = QUESTION) -> List[str]:
    """Scripted realtime event sequence for a single agent turn."""
    pcm_chunk = _b64_pcm(480)
    return [
        json.dumps({"type": "response.created"}),
        json.dumps({"type": "response.output_audio.delta", "delta": pcm_chunk}),
        json.dumps({"type": "response.output_audio.delta", "delta": pcm_chunk}),
        json.dumps({"type": "response.output_audio.delta", "delta": pcm_chunk}),
        json.dumps({
            "type": "response.output_audio_transcript.done",
            "transcript": question,
        }),
        json.dumps({"type": "response.done"}),
    ]


# ---------------------------------------------------------------------------
# Parrot LLM stub
# ---------------------------------------------------------------------------

def _make_parrot_response(text: str) -> _LiteLLMModelResponse:
    """Build a real litellm ModelResponse so langwatch tracing can serialize it."""
    return _LiteLLMModelResponse(
        id="parrot-stub",
        choices=[{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        model="gpt-4.1-mini",
        object="chat.completion",
    )


def _parrot_completion(**kwargs):
    """
    Parrot: returns the content of the last user-role message in the prompt.

    After reverse_roles the agent's turn becomes a "user" message. Without the
    reframe fix the text is the raw question Q — the parrot echoes Q back.
    With the fix the text is "[the agent said: Q]" — the parrot echoes that
    framing, not Q verbatim.
    """
    messages = kwargs.get("messages", [])
    # Find last user-role message (not the system bootstrap or assistant greeting).
    # After reverse_roles the AUT's message is role=user.
    last_user = None
    for m in reversed(messages):
        if m.get("role") == "user":
            last_user = m.get("content", "")
            break
    parrot_text = last_user or ""
    return _make_parrot_response(parrot_text)


# ---------------------------------------------------------------------------
# Fixture: configure ScenarioConfig so UserSimulatorAgent can init
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _configure_scenario(monkeypatch):
    """Provide a minimal ScenarioConfig and suppress LangWatch network calls.

    We unset LANGWATCH_API_KEY and patch the event reporter's post_event so
    no network calls go out. The reporter silently no-ops when api_key is
    absent — see scenario/_events/event_reporter.py:143-156.
    """
    monkeypatch.delenv("LANGWATCH_API_KEY", raising=False)
    monkeypatch.delenv("LANGWATCH_ENDPOINT", raising=False)
    # Provide a dummy OpenAI key so AsyncOpenAI() construction does not raise
    # "Missing credentials" if any un-mocked path reaches client init.
    # The real synthesize is always patched in these tests, so no network call
    # is made; this is a belt-and-suspenders hermetic floor.
    monkeypatch.setenv("OPENAI_API_KEY", "test-sk-not-a-real-key")
    monkeypatch.setenv("OPENAI_ADMIN_KEY", "test-sk-not-a-real-key")
    # Also clear the langwatch SDK's class-level api_key if set.
    try:
        from langwatch.client import Client
        monkeypatch.setattr(Client, "_api_key", "", raising=False)
    except ImportError:
        pass  # langwatch SDK not importable in this env — hermetic floor is best-effort
    # Patch event reporter post_event to a no-op so no HTTP calls are made
    # even if the endpoint is configured via some other path.
    try:
        from scenario._events.event_reporter import EventReporter

        async def _noop_post_event(self, event):
            return {}

        monkeypatch.setattr(EventReporter, "post_event", _noop_post_event)
    except ImportError:
        pass  # event reporter not importable — no-op floor is best-effort

    prev = ScenarioConfig.default_config
    ScenarioConfig.default_config = ScenarioConfig(
        default_model="openai/gpt-4.1-mini",
        verbose=False,
    )
    yield
    ScenarioConfig.default_config = prev


# ---------------------------------------------------------------------------
# Helpers to build and wire the adapter
# ---------------------------------------------------------------------------

async def _run_echo_test(
    *,
    with_reframe: bool = True,
    question: str = QUESTION,
) -> tuple:
    """
    Run the echo scenario and return (result, simulator_reply, jaccard_value).

    ``with_reframe=True``  → uses the real _strip_audio_content (echo-safe fix).
    ``with_reframe=False`` → monkeypatches _strip_audio_content to bypass the
                             reframe so it behaves like naive surfacing (pre-fix
                             contrast control).
    """
    events = _agent_event_sequence(question)
    mock_ws = _MockWS(events)

    adapter = OpenAIRealtimeAgentAdapter(
        model="gpt-4o-realtime-preview",
        voice="alloy",
        instructions="You are an interviewer. Ask about the candidate's experience.",
        speaks_first=True,
    )

    # Bypass the real WebSocket connect.
    async def _fake_connect():
        adapter._ws = mock_ws

    async def _fake_disconnect():
        adapter._ws = None

    adapter.connect = _fake_connect  # type: ignore[method-assign]
    adapter.disconnect = _fake_disconnect  # type: ignore[method-assign]

    # User simulator with voice so _generate_text runs (free-running).
    user_sim = UserSimulatorAgent(
        model="openai/gpt-4.1-mini",
        voice="openai/nova",
    )

    # Stub TTS so we don't need a real OpenAI TTS key.
    async def _fake_synthesize(text: str, voice: str):
        from scenario.voice.audio_chunk import AudioChunk
        return AudioChunk(data=_make_pcm(2400), transcript=text)

    # The reframe is inside _strip_audio_content. For the pre-fix contrast we
    # bypass the reframe by patching _strip_audio_content to the old (naive)
    # behaviour, but keep the audio-stripping logic.
    def _naive_strip_audio_content(messages: list) -> list:
        """Old behaviour: text parts on assistant turns are passed verbatim."""
        result = []
        for msg in messages:
            content = msg.get("content")
            if isinstance(content, list):
                text_parts = [
                    p["text"]
                    for p in content
                    if isinstance(p, dict) and p.get("type") == "text"
                ]
                if text_parts:
                    result.append({**msg, "content": " ".join(text_parts)})
                else:
                    result.append({**msg, "content": "[audio message]"})
            else:
                result.append(msg)
        return result

    script = [
        scenario.agent(),
        scenario.user(),
        scenario.succeed("done"),
    ]

    with patch("scenario.voice.synthesize", side_effect=_fake_synthesize):
        with patch(
            "scenario.user_simulator_agent.litellm.completion",
            side_effect=_parrot_completion,
        ):
            if with_reframe:
                result = await scenario.arun(
                    name="echo-safe-test",
                    description="Candidate answers an interviewer's opening question",
                    agents=[adapter, user_sim],
                    script=script,
                )
            else:
                with patch(
                    "scenario.user_simulator_agent._strip_audio_content",
                    side_effect=_naive_strip_audio_content,
                ):
                    result = await scenario.arun(
                        name="echo-safe-test-naive",
                        description="Candidate answers an interviewer's opening question",
                        agents=[adapter, user_sim],
                        script=script,
                    )

    # Extract the simulator's reply: the first user-role message after the
    # agent's opening turn.
    sim_reply = ""
    for msg in result.messages:
        if msg.get("role") == "user":
            content = msg.get("content")
            if isinstance(content, str):
                sim_reply = content
                break
            elif isinstance(content, list):
                text_parts = [
                    p.get("text", "")
                    for p in content
                    if isinstance(p, dict) and p.get("type") == "text"
                ]
                if text_parts:
                    sim_reply = " ".join(text_parts)
                    break

    j = jaccard(sim_reply, question)
    return result, sim_reply, j


# ---------------------------------------------------------------------------
# AC4 / AC7 — main echo test (post-fix + contrast)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_echo_safe_post_fix_jaccard_below_threshold():
    """
    AC4 (post-fix): Jaccard(U, Q) < 0.8 — reframe prevents echo.
    AC7: run-shape ≥ 3 messages, user-role turn present.
    """
    result, sim_reply, j = await _run_echo_test(with_reframe=True)

    print(f"\n[POST-FIX] Q={QUESTION!r}")
    print(f"[POST-FIX] U={sim_reply!r}")
    print(f"[POST-FIX] Jaccard={j:.3f}")

    # Run-shape assertions (AC7): at minimum an assistant (agent) turn and
    # a user (simulator) turn. The script is [agent(), user(), succeed()],
    # so exactly 2 messages: one assistant audio turn + one user reply.
    assert len(result.messages) >= 2, (
        f"Expected ≥ 2 messages (agent opening + user reply), "
        f"got {len(result.messages)}"
    )
    user_roles = [m for m in result.messages if m.get("role") == "user"]
    assert user_roles, "Expected at least one user-role message in result.messages"
    assistant_roles = [m for m in result.messages if m.get("role") == "assistant"]
    assert assistant_roles, "Expected at least one assistant-role message in result.messages"

    # AC4: echo must be broken.
    assert j < 0.8, (
        f"Post-fix Jaccard {j:.3f} ≥ 0.8 — reframe did not break the echo. "
        f"Q={QUESTION!r}, U={sim_reply!r}"
    )


@pytest.mark.asyncio
async def test_echo_naive_contrast_jaccard_above_threshold():
    """
    AC4 (pre-fix/naive contrast): Jaccard(U, Q) > 0.8 — echo metric IS
    red-capable without the reframe.

    This uses the same parrot stub but bypasses the reframe in
    _strip_audio_content to simulate the naive (pre-fix) surfacing.
    The parrot echoes the raw Q text → Jaccard > 0.8.
    """
    _, sim_reply, j = await _run_echo_test(with_reframe=False)

    print(f"\n[PRE-FIX]  Q={QUESTION!r}")
    print(f"[PRE-FIX]  U={sim_reply!r}")
    print(f"[PRE-FIX]  Jaccard={j:.3f}")

    assert j > 0.8, (
        f"Pre-fix (naive) Jaccard {j:.3f} ≤ 0.8 — the contrast control is not "
        f"detecting the echo. Q={QUESTION!r}, U={sim_reply!r}"
    )


# ---------------------------------------------------------------------------
# AC11 — no marker key leaks to result.messages
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_no_scenario_origin_marker_in_result_messages():
    """AC11: 'scenario_origin' must not appear in result.messages."""
    result, _, _ = await _run_echo_test(with_reframe=True)
    dumped = json.dumps([dict(m) for m in result.messages])
    assert "scenario_origin" not in dumped, (
        "Marker key 'scenario_origin' leaked into result.messages"
    )


@pytest.mark.asyncio
async def test_assistant_turn_has_no_extra_keys():
    """
    AC11 (structural): the assistant turn's text part has only the standard
    keys {type, text} — no hidden marker keys.
    """
    result, _, _ = await _run_echo_test(with_reframe=True)
    for msg in result.messages:
        if msg.get("role") == "assistant":
            content = msg.get("content")
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        assert set(part.keys()) == {"type", "text"}, (
                            f"Unexpected keys on text part: {set(part.keys())}"
                        )


# ---------------------------------------------------------------------------
# AC1 — agent-first via speaks_first produces a turn (no TimeoutError)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_agent_first_produces_turn():
    """
    AC1: speaks_first=True makes the adapter send a bare response.create and
    receive an agent turn without TimeoutError.
    """
    events = _agent_event_sequence(QUESTION)
    mock_ws = _MockWS(events)

    adapter = OpenAIRealtimeAgentAdapter(speaks_first=True)

    async def _fake_connect():
        adapter._ws = mock_ws

    async def _fake_disconnect():
        adapter._ws = None

    adapter.connect = _fake_connect  # type: ignore[method-assign]
    adapter.disconnect = _fake_disconnect  # type: ignore[method-assign]

    # Use a scripted user to avoid needing an LLM.
    with patch("scenario.voice.tts.synthesize") as mock_tts:
        async def _fake_synth(text, voice):
            from scenario.voice.audio_chunk import AudioChunk
            return AudioChunk(data=_make_pcm(2400), transcript=text)
        mock_tts.side_effect = _fake_synth

        result = await scenario.arun(
            name="agent-first-ac1",
            description="Agent opens with a greeting",
            agents=[adapter],
            script=[
                scenario.agent(),
                scenario.succeed("done"),
            ],
        )

    # Should not have timed out.
    assert result.success, f"Expected success; got: {result.reasoning}"

    # AC1: an agent (assistant-role) audio turn must be present.
    assistant_turns = [m for m in result.messages if m.get("role") == "assistant"]
    assert assistant_turns, "No assistant turn found — agent did not speak"
    # The turn must have an audio part.
    content = assistant_turns[0].get("content", [])
    audio_parts = [
        p for p in content
        if isinstance(p, dict) and p.get("type") == "input_audio"
    ] if isinstance(content, list) else []
    assert audio_parts, "Assistant turn has no audio part"


# ---------------------------------------------------------------------------
# AC2 — transcript text part appears in result.messages
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_transcript_in_result_messages():
    """AC2: the assistant turn in result.messages contains a text part with Q."""
    result, _, _ = await _run_echo_test(with_reframe=True)

    found_text = False
    for msg in result.messages:
        if msg.get("role") == "assistant":
            content = msg.get("content", [])
            if isinstance(content, list):
                for part in content:
                    if (
                        isinstance(part, dict)
                        and part.get("type") == "text"
                        and QUESTION in (part.get("text") or "")
                    ):
                        found_text = True
    assert found_text, (
        f"Expected assistant turn in result.messages to contain text={QUESTION!r}. "
        f"Messages: {result.messages}"
    )


# ---------------------------------------------------------------------------
# AC8 — empty transcript → no empty text part
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_empty_transcript_no_empty_text_part():
    """
    AC8: if the transcript event carries an empty string (or is absent),
    the assistant message must NOT contain an empty {"type":"text","text":""} part.
    """
    # Build event sequence without a transcript event.
    pcm_chunk = _b64_pcm(480)
    events_no_transcript = [
        json.dumps({"type": "response.created"}),
        json.dumps({"type": "response.output_audio.delta", "delta": pcm_chunk}),
        json.dumps({"type": "response.output_audio.delta", "delta": pcm_chunk}),
        # transcript.done with empty string
        json.dumps({"type": "response.output_audio_transcript.done", "transcript": ""}),
        json.dumps({"type": "response.done"}),
    ]

    mock_ws = _MockWS(events_no_transcript)
    adapter = OpenAIRealtimeAgentAdapter(speaks_first=True)

    async def _fake_connect():
        adapter._ws = mock_ws

    async def _fake_disconnect():
        adapter._ws = None

    adapter.connect = _fake_connect  # type: ignore[method-assign]
    adapter.disconnect = _fake_disconnect  # type: ignore[method-assign]

    result = await scenario.arun(
        name="empty-transcript-ac8",
        description="Agent with empty transcript",
        agents=[adapter],
        script=[
            scenario.agent(),
            scenario.succeed("done"),
        ],
    )

    for msg in result.messages:
        if msg.get("role") == "assistant":
            content = msg.get("content", [])
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        assert part.get("text"), (
                            "Empty text part found on assistant message (AC8 violation)"
                        )


# ---------------------------------------------------------------------------
# AC9 — multi-turn [agent(), user(), agent()] each agent step fires once
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_multi_turn_agent_user_agent():
    """
    AC9: [agent(), user(...), agent()] — each agent step produces exactly
    one non-empty assistant turn.

    Uses _CommandDrivenMockWS so turn-2 events are only emitted after the
    second response.create is sent — preventing premature event consumption
    during turn-1's tail-silence drain.
    """
    turn1_events = _agent_event_sequence("what is your background")
    turn2_events = _agent_event_sequence("tell me about a challenge you faced")

    # Command-driven: each response.create triggers one sequence.
    mock_ws = _CommandDrivenMockWS([turn1_events, turn2_events])

    adapter = OpenAIRealtimeAgentAdapter(speaks_first=True)

    async def _fake_connect():
        adapter._ws = mock_ws

    async def _fake_disconnect():
        adapter._ws = None

    adapter.connect = _fake_connect  # type: ignore[method-assign]
    adapter.disconnect = _fake_disconnect  # type: ignore[method-assign]

    with patch(
        "scenario.user_simulator_agent.litellm.completion",
        side_effect=_parrot_completion,
    ):
        with patch("scenario.voice.synthesize") as mock_tts:
            async def _fake_synth(text, voice):
                from scenario.voice.audio_chunk import AudioChunk
                return AudioChunk(data=_make_pcm(2400), transcript=text)
            mock_tts.side_effect = _fake_synth

            user_sim = UserSimulatorAgent(
                model="openai/gpt-4.1-mini",
                voice="openai/nova",
            )

            result = await scenario.arun(
                name="multi-turn-agent-ac9",
                description="Two-agent-turn script",
                agents=[adapter, user_sim],
                script=[
                    scenario.agent(),
                    scenario.user(),
                    scenario.agent(),
                    scenario.succeed("done"),
                ],
            )

    assistant_turns = [m for m in result.messages if m.get("role") == "assistant"]
    assert len(assistant_turns) == 2, (
        f"Expected exactly 2 assistant turns for [agent(), user(), agent()], "
        f"got {len(assistant_turns)}"
    )
    # Both turns must have audio content (non-empty).
    for i, turn in enumerate(assistant_turns):
        content = turn.get("content", [])
        audio_parts = [
            p for p in content
            if isinstance(p, dict) and p.get("type") == "input_audio"
        ] if isinstance(content, list) else []
        assert audio_parts, f"Assistant turn {i} has no audio part"


# ---------------------------------------------------------------------------
# AC10 — no spurious response.create on a non-opening no-pending-audio turn
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_no_spurious_response_create_on_user_first():
    """
    AC3/AC10: user-first script — the agent-first kick does NOT fire.
    The WS should receive exactly one response.create (from the user-audio
    commit path), not two.
    """
    # For user-first: user speaks first, then agent responds.
    pcm_chunk = _b64_pcm(480)
    agent_events = [
        json.dumps({"type": "response.created"}),
        json.dumps({"type": "response.output_audio.delta", "delta": pcm_chunk}),
        json.dumps({"type": "response.output_audio.delta", "delta": pcm_chunk}),
        json.dumps({"type": "response.output_audio_transcript.done", "transcript": "I can help you."}),
        json.dumps({"type": "response.done"}),
    ]
    mock_ws = _MockWS(agent_events)

    # NOT speaks_first — user opens the conversation.
    adapter = OpenAIRealtimeAgentAdapter(speaks_first=False)

    async def _fake_connect():
        adapter._ws = mock_ws

    async def _fake_disconnect():
        adapter._ws = None

    adapter.connect = _fake_connect  # type: ignore[method-assign]
    adapter.disconnect = _fake_disconnect  # type: ignore[method-assign]

    user_sim = UserSimulatorAgent(
        model="openai/gpt-4.1-mini",
        voice="openai/nova",
    )

    with patch("scenario.voice.synthesize") as mock_tts:
        async def _fake_synth(text, voice):
            from scenario.voice.audio_chunk import AudioChunk
            return AudioChunk(data=_make_pcm(2400), transcript=text)
        mock_tts.side_effect = _fake_synth

        result = await scenario.arun(
            name="user-first-ac3-ac10",
            description="User-first scenario (regression check)",
            agents=[adapter, user_sim],
            script=[
                scenario.user("hello"),
                scenario.agent(),
                scenario.succeed("done"),
            ],
        )

    # Count how many response.create messages were sent to the WS.
    sent_creates = [
        s for s in mock_ws.sent
        if isinstance(s, str) and '"response.create"' in s
    ]
    assert len(sent_creates) == 1, (
        f"Expected exactly 1 response.create for user-first script, "
        f"got {len(sent_creates)}: {sent_creates}"
    )

    # Result must succeed and have exactly one assistant turn.
    assistant_turns = [m for m in result.messages if m.get("role") == "assistant"]
    assert len(assistant_turns) == 1, (
        f"Expected exactly 1 assistant turn, got {len(assistant_turns)}"
    )


# ---------------------------------------------------------------------------
# Wrapper-level smoke — REAL .connect() + .call() over a faked network client
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_wrapper_real_connect_call_disconnect_smoke(monkeypatch):
    """Wrapper-level (real ``.connect()`` + ``.call()``) smoke test closing the
    seam-only gap.

    Every other test in this suite replaces ``connect`` wholesale (assigning
    ``adapter._ws`` directly), so the real ``session.update`` handshake
    (openai_realtime.py:305-343) had ZERO coverage before this test. Here we fake
    ONLY the network-client boundary — ``websockets.connect`` — and drive the
    REAL connect handshake, the REAL ``call()`` drain, and the REAL disconnect
    over that fake transport.
    """
    import websockets

    mock_ws = _MockWS(_agent_event_sequence(QUESTION))
    captured: dict = {}

    async def _fake_connect(url, additional_headers=None, **kw):
        captured["url"] = url
        captured["headers"] = dict(additional_headers or {})
        return mock_ws

    monkeypatch.setattr(websockets, "connect", _fake_connect)

    adapter = OpenAIRealtimeAgentAdapter(
        api_key="test-sk-not-real",
        instructions="You are an interviewer.",
        speaks_first=True,
    )

    await adapter.connect()             # REAL connect: URL, auth header, session.update
    result = await drive_call(adapter)  # REAL call(): drain + transcript override
    await adapter.disconnect()

    # 1. Real endpoint URL + real auth header over the fake transport.
    assert captured["url"] == f"wss://api.openai.com/v1/realtime?model={adapter.model}", (
        f"connect() did not build the real Realtime URL; got {captured.get('url')!r}"
    )
    assert captured["headers"].get("Authorization") == "Bearer test-sk-not-real", (
        f"connect() did not send the Bearer auth header; headers={captured.get('headers')!r}"
    )

    # 2. The session.update handshake — asserted structurally (the exact code the
    #    seam tests skipped).
    assert mock_ws.sent, "connect() sent nothing — session.update handshake missing"
    handshake = json.loads(mock_ws.sent[0])
    assert handshake.get("type") == "session.update", (
        f"first send was not session.update; got {handshake.get('type')!r}"
    )
    session = handshake["session"]
    assert session.get("type") == "realtime", (
        f"session.type != 'realtime'; got {session.get('type')!r}"
    )
    assert session["audio"]["input"]["format"] == {"type": "audio/pcm", "rate": 24000}, (
        f"input format wrong; got {session['audio']['input'].get('format')!r}"
    )
    assert session["audio"]["input"]["turn_detection"] is None, (
        "server VAD not disabled (turn_detection should be None)"
    )
    assert session["audio"]["output"]["voice"] == adapter.voice, (
        f"output voice != adapter.voice; got {session['audio']['output'].get('voice')!r}"
    )
    assert session.get("instructions"), (
        "instructions absent from the session.update handshake"
    )

    # 3. Ordering: the session.update send precedes any response.create send.
    sent_types = [
        json.loads(s).get("type") for s in mock_ws.sent if isinstance(s, str)
    ]
    assert "session.update" in sent_types and "response.create" in sent_types, (
        f"expected both session.update and response.create in sends; got {sent_types}"
    )
    assert sent_types.index("session.update") < sent_types.index("response.create"), (
        f"session.update must precede response.create; sent order={sent_types}"
    )

    # 4. The assistant turn carries non-empty audio AND the surfaced transcript.
    content = result.get("content") if isinstance(result, dict) else None
    assert isinstance(content, list), f"result is not an assistant audio message: {result!r}"
    audio_parts = [
        p for p in content if isinstance(p, dict) and p.get("type") == "input_audio"
    ]
    text_parts = [
        p for p in content if isinstance(p, dict) and p.get("type") == "text"
    ]
    assert audio_parts and audio_parts[0]["input_audio"].get("data"), (
        "assistant turn has no non-empty input_audio part"
    )
    assert any(QUESTION in (p.get("text") or "") for p in text_parts), (
        f"transcript {QUESTION!r} not surfaced as a text part through the real drain"
    )

    # 5. Disconnect is observable and clears the socket reference.
    assert mock_ws.closed is True, "disconnect() did not close the websocket"
    assert adapter._ws is None, "disconnect() did not clear adapter._ws"
