"""
AC-PY1' — Echo-safety REGRESSION test for GeminiLiveAgentAdapter.

This test LOCKS already-correct behaviour. Gemini Live is ALREADY echo-safe:
its ``recv_audio`` sets ``transcript=`` on the assistant ``AudioChunk`` (from
the server's ``output_transcription``), which the shared base
``VoiceAgentAdapter.call`` turns into an assistant turn carrying BOTH an
``input_audio`` part AND a ``text`` part. That voiced-agent turn then hits the
SHARED reframe in ``UserSimulatorAgent._strip_audio_content`` — the same code
path that makes the OpenAI Realtime adapter echo-safe (see
``test_realtime_agent_echo_safe.py``). So the post-fix arm is GREEN now and NO
production change is expected. If the post-fix arm comes out RED, Gemini is NOT
actually echo-safe — that is a finding, not something to force green.

Mock strategy (creds-free, no API key, no ``google-genai`` SDK):
- The Gemini Live SDK session (``AsyncSession``) is replaced by a duck-typed
  ``_FakeSession`` whose ``receive()`` yields ``LiveServerMessage``-shaped
  objects (``server_content.output_transcription`` + ``server_content.model_turn``
  + ``turn_complete``). ``connect``/``disconnect``/``send_audio`` are overridden
  to be creds-free — they are the ONLY methods that import ``google.genai``
  (``recv_audio`` does not), so the REAL ``recv_audio`` runs and exercises the
  genuine transcript-surfacing path (gemini_live.py lines ~403-423).
- ``litellm.completion`` is stubbed to a "parrot" returning the most-recent
  user-role content VERBATIM. After ``reverse_roles`` the agent's turn becomes
  a "user" message; WITHOUT the reframe the parrot would echo the raw question
  Q back as the candidate's answer (Jaccard >= 0.8). WITH the reframe the text
  is ``[the agent said: Q]`` so the parrot cannot echo Q verbatim (< 0.8).

Kept REAL (code under test — do NOT monkeypatch):
- ``_strip_audio_content`` (the shared reframe)
- ``reverse_roles``
- ``create_audio_message`` (transcript -> text part)
- ``GeminiLiveAgentAdapter.recv_audio`` (sets transcript on the AudioChunk)

AC-PY1' contract (both arms, SAME test):
  Q = the agent's spoken question (the fake session's output_transcription)
  U = the user-sim's generated reply (parrot stub via REAL _generate_text)
  post-fix:     jaccard(U, Q) <  0.8   (shared reframe breaks verbatim echo)
  naive arm:    jaccard(U, Q) >= 0.8   (reframe disabled -> parrot echoes Q)
  margin floor: naive - postfix >= 0.3 (proves the metric is red-capable here)

Run-shape floor (mirrors the OpenAI reference's run-shape assertions):
  messageCount >= 3, >= 1 user-role turn, >= 1 assistant-role turn.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, List, Optional

from litellm.files.main import ModelResponse as _LiteLLMModelResponse

import pytest

import scenario
from scenario.config import ScenarioConfig
from scenario.voice.adapters.gemini_live import GeminiLiveAgentAdapter
from scenario.user_simulator_agent import UserSimulatorAgent


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

QUESTION = "what was your role on the payments team"


def _make_pcm(n_samples: int = 2400) -> bytes:
    """Minimal silent PCM16 mono @ 24 kHz."""
    return b"\x00\x00" * n_samples


def jaccard(a: str, b: str) -> float:
    """Word-set Jaccard overlap — ported verbatim from the OpenAI reference."""
    wa = set(a.lower().split())
    wb = set(b.lower().split())
    if not wa and not wb:
        return 1.0
    return len(wa & wb) / len(wa | wb)


# ---------------------------------------------------------------------------
# Duck-typed Gemini Live server-message shapes (no google-genai dependency)
# ---------------------------------------------------------------------------
#
# The real recv_audio reads:
#   message.go_away
#   message.server_content (sc)
#     sc.interrupted
#     sc.output_transcription.text
#     sc.model_turn.parts[].inline_data.data
#     sc.turn_complete
# We provide just those attributes — the SDK's concrete LiveServerMessage type
# is never imported.


class _FakePart:
    def __init__(self, data: Optional[bytes]) -> None:
        self.inline_data = _FakeInlineData(data) if data is not None else None


class _FakeInlineData:
    def __init__(self, data: bytes) -> None:
        self.data = data


class _FakeModelTurn:
    def __init__(self, parts: List[_FakePart]) -> None:
        self.parts = parts


class _FakeTranscription:
    def __init__(self, text: Optional[str]) -> None:
        self.text = text


class _FakeServerContent:
    def __init__(
        self,
        *,
        output_transcription: Optional[_FakeTranscription] = None,
        model_turn: Optional[_FakeModelTurn] = None,
        turn_complete: bool = False,
        interrupted: bool = False,
    ) -> None:
        self.output_transcription = output_transcription
        self.model_turn = model_turn
        self.turn_complete = turn_complete
        self.interrupted = interrupted


class _FakeLiveServerMessage:
    def __init__(self, server_content: Optional[_FakeServerContent]) -> None:
        self.go_away = None
        self.server_content = server_content


def _agent_turn_messages(question: str = QUESTION) -> List[_FakeLiveServerMessage]:
    """One Gemini Live agent turn: transcript+audio, then turn_complete.

    The output_transcription rides the SAME message as the audio part so that
    when recv_audio returns the audio chunk it carries ``transcript=question``
    (recv_audio accumulates transcription into ``pending_delta`` BEFORE
    inspecting ``model_turn`` within the loop body, then returns the chunk with
    ``transcript=pending_delta``). A trailing ``turn_complete`` message ends the
    turn so the base ``_drain_agent_response`` sees the empty chunk and exits.
    """
    return [
        _FakeLiveServerMessage(
            _FakeServerContent(
                output_transcription=_FakeTranscription(question),
                model_turn=_FakeModelTurn([_FakePart(_make_pcm(2400))]),
            )
        ),
        _FakeLiveServerMessage(
            _FakeServerContent(turn_complete=True),
        ),
    ]


class _FakeSession:
    """Duck-typed stand-in for the google-genai ``AsyncSession``.

    ``receive()`` returns a FRESH async generator each call that yields ONE
    agent turn's messages then stops (StopAsyncIteration) — matching the real
    SDK, whose ``session.receive()`` generator yields one model turn then
    completes. The real ``recv_audio`` caches this iterator on ``_recv_iter``
    and re-creates it per user turn, so a fresh generator per ``receive()`` call
    is the faithful contract.

    ``send_realtime_input`` is recorded but never reached here (send_audio is
    overridden creds-free in the test), kept for completeness.
    """

    def __init__(self, turns: List[List[_FakeLiveServerMessage]]) -> None:
        self._turns = list(turns)
        self._turn_idx = 0
        self.sent: List[Any] = []

    def receive(self):
        # Pick the next turn's message list; an exhausted schedule yields an
        # immediately-completing (empty) generator so any extra recv settles
        # to end-of-turn rather than hanging.
        if self._turn_idx < len(self._turns):
            msgs = self._turns[self._turn_idx]
            self._turn_idx += 1
        else:
            msgs = []

        async def _gen():
            for m in msgs:
                await asyncio.sleep(0)
                yield m

        return _gen()

    async def send_realtime_input(self, **kwargs: Any) -> None:
        self.sent.append(kwargs)

    async def close(self) -> None:
        pass


# ---------------------------------------------------------------------------
# Parrot LLM stub (ported from the OpenAI reference)
# ---------------------------------------------------------------------------

def _make_parrot_response(text: str) -> _LiteLLMModelResponse:
    """Build a real litellm ModelResponse so langwatch tracing can serialize it."""
    return _LiteLLMModelResponse(
        id="parrot-stub",
        choices=[
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        model="gpt-4.1-mini",
        object="chat.completion",
    )


def _parrot_completion(**kwargs):
    """Return the content of the last user-role message in the prompt VERBATIM.

    After reverse_roles the agent's turn becomes a "user" message. Without the
    reframe the text is the raw question Q — the parrot echoes Q back. With the
    fix the text is ``[the agent said: Q]`` — the parrot echoes that framing,
    not Q verbatim.
    """
    messages = kwargs.get("messages", [])
    last_user = None
    for m in reversed(messages):
        if m.get("role") == "user":
            last_user = m.get("content", "")
            break
    parrot_text = last_user or ""
    return _make_parrot_response(parrot_text)


# ---------------------------------------------------------------------------
# Naive-strip contrast control (reframe disabled) — ported from OpenAI ref
# ---------------------------------------------------------------------------

def _naive_strip_audio_content(messages: list) -> list:
    """Old (pre-fix) behaviour: assistant text parts pass through VERBATIM.

    Identical audio-stripping to the real helper, but WITHOUT the
    ``[the agent said: ...]`` reframe on voiced assistant turns — so after
    reverse_roles the raw question Q flows into the reversed user turn and the
    parrot echoes it. This is the red-capability control proving the Jaccard
    metric fires on Gemini's message shape.
    """
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


# ---------------------------------------------------------------------------
# Fixture: configure ScenarioConfig + hermetic floor (ported from OpenAI ref)
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _configure_scenario(monkeypatch):
    """Minimal ScenarioConfig + suppress LangWatch network calls.

    Mirrors the OpenAI reference's hermetic floor: unset LangWatch env, provide
    dummy OpenAI keys so any un-mocked client construction does not raise, and
    no-op the event reporter so no HTTP escapes.
    """
    monkeypatch.delenv("LANGWATCH_API_KEY", raising=False)
    monkeypatch.delenv("LANGWATCH_ENDPOINT", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "test-sk-not-a-real-key")
    monkeypatch.setenv("OPENAI_ADMIN_KEY", "test-sk-not-a-real-key")
    # No GEMINI_API_KEY needed — connect() is overridden creds-free below.
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    try:
        from langwatch.client import Client

        monkeypatch.setattr(Client, "_api_key", "", raising=False)
    except ImportError:
        pass  # langwatch SDK not importable — hermetic floor is best-effort
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
# Wire the Gemini adapter creds-free and run the echo scenario
# ---------------------------------------------------------------------------

def _wire_creds_free(adapter: GeminiLiveAgentAdapter, session: _FakeSession) -> None:
    """Override the ONLY google.genai-importing methods so no SDK/key is needed.

    ``connect``/``disconnect``/``send_audio`` are the sole methods that
    ``from google.genai import types`` (or construct ``genai.Client``).
    ``recv_audio`` imports nothing google — it stays REAL so the genuine
    transcript-surfacing path runs against the fake session.
    """

    async def _fake_connect() -> None:
        adapter._session = session
        adapter._recv_iter = None

    async def _fake_disconnect() -> None:
        adapter._session = None
        adapter._recv_iter = None

    async def _fake_send_audio(chunk) -> None:
        # Real send_audio resamples + emits google ActivityStart/Blob/ActivityEnd
        # — all google-genai-typed and irrelevant to the echo path (it only ships
        # USER audio to Google). We reproduce only the framework-visible side
        # effect: reset the per-turn transcript + receive iterator so the next
        # recv_audio enters session.receive() fresh for the new turn.
        adapter._reset_turn_transcript()
        adapter._recv_iter = None

    adapter.connect = _fake_connect  # type: ignore[method-assign]
    adapter.disconnect = _fake_disconnect  # type: ignore[method-assign]
    adapter.send_audio = _fake_send_audio  # type: ignore[method-assign]


async def _run_echo_test(
    *,
    with_reframe: bool,
    question: str = QUESTION,
) -> tuple:
    """Run the Gemini echo scenario; return (result, sim_reply, jaccard_value).

    ``with_reframe=True``  -> REAL _strip_audio_content (echo-safe; GREEN now).
    ``with_reframe=False`` -> _strip_audio_content patched to the naive
                              (pre-fix) surfacing so the parrot echoes Q.
    """
    from unittest.mock import patch

    # Two agent turns scheduled so [agent(), user(), agent()] each read a turn.
    session = _FakeSession([_agent_turn_messages(question), _agent_turn_messages(question)])

    adapter = GeminiLiveAgentAdapter(
        system_instruction="You are an interviewer. Ask about the candidate's experience.",
    )
    _wire_creds_free(adapter, session)

    # User simulator WITH voice so _generate_text runs (free-running, no script text).
    user_sim = UserSimulatorAgent(
        model="openai/gpt-4.1-mini",
        voice="openai/nova",
    )

    # Neutralise real TTS — no live synth key needed.
    async def _fake_synthesize(text: str, voice: str):
        from scenario.voice.audio_chunk import AudioChunk
        return AudioChunk(data=_make_pcm(2400), transcript=text)

    script = [
        scenario.agent(),
        scenario.user(),
        scenario.agent(),
        scenario.succeed("done"),
    ]

    with patch("scenario.voice.synthesize", side_effect=_fake_synthesize):
        with patch(
            "scenario.user_simulator_agent.litellm.completion",
            side_effect=_parrot_completion,
        ):
            if with_reframe:
                result = await scenario.arun(
                    name="gemini-echo-safe",
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
                        name="gemini-echo-naive",
                        description="Candidate answers an interviewer's opening question",
                        agents=[adapter, user_sim],
                        script=script,
                    )

    # Extract the simulator's reply: the first user-role text after the agent's
    # opening turn (mirrors the OpenAI reference's extraction).
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

    return result, sim_reply, jaccard(sim_reply, question)


# ---------------------------------------------------------------------------
# AC-PY1' — Gemini echo-safety regression: post-fix GREEN + naive red-capable
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_gemini_echo_safe_regression_both_arms():
    """AC-PY1' (regression): Gemini Live is ALREADY echo-safe via the shared
    _strip_audio_content reframe.

    Both arms in ONE test:
      post-fix:     jaccard(U, Q) <  0.8   (GREEN now — reframe breaks echo)
      naive:        jaccard(U, Q) >= 0.8   (red-capability control)
      margin floor: naive - postfix >= 0.3 (metric is red-capable on Gemini)

    Run-shape floor: messageCount >= 3, >= 1 user-role, >= 1 assistant-role.
    """
    # --- Post-fix arm (real shared reframe; already echo-safe) ---
    result, sim_reply, j_post = await _run_echo_test(with_reframe=True)

    print(f"\n[GEMINI POST-FIX] Q={QUESTION!r}")
    print(f"[GEMINI POST-FIX] U={sim_reply!r}")
    print(f"[GEMINI POST-FIX] Jaccard={j_post:.3f}")

    # Run-shape floor (mirrors OpenAI reference's run-shape assertions).
    assert len(result.messages) >= 3, (
        f"Expected >= 3 messages for [agent(), user(), agent()], "
        f"got {len(result.messages)}: {result.messages}"
    )
    user_roles = [m for m in result.messages if m.get("role") == "user"]
    assert user_roles, "Expected at least one user-role message in result.messages"
    assistant_roles = [m for m in result.messages if m.get("role") == "assistant"]
    assert assistant_roles, "Expected at least one assistant-role message in result.messages"

    # Echo-safety: the reframe must break the verbatim echo.
    assert j_post < 0.8, (
        f"Post-fix Jaccard {j_post:.3f} >= 0.8 — Gemini is NOT echo-safe; the "
        f"shared reframe did not break the echo. This is a FINDING. "
        f"Q={QUESTION!r}, U={sim_reply!r}"
    )

    # --- Naive arm (reframe disabled; red-capability control) ---
    _, sim_reply_naive, j_naive = await _run_echo_test(with_reframe=False)

    print(f"\n[GEMINI NAIVE]    Q={QUESTION!r}")
    print(f"[GEMINI NAIVE]    U={sim_reply_naive!r}")
    print(f"[GEMINI NAIVE]    Jaccard={j_naive:.3f}")

    assert j_naive >= 0.8, (
        f"Naive Jaccard {j_naive:.3f} < 0.8 — the red-capability control did "
        f"not detect the echo on Gemini's message shape. The metric may not be "
        f"red-capable here. Q={QUESTION!r}, U={sim_reply_naive!r}"
    )

    # --- Margin floor: the metric meaningfully separates the two arms ---
    margin = j_naive - j_post
    print(f"[GEMINI MARGIN]   naive - postfix = {margin:.3f}")
    assert margin >= 0.3, (
        f"Margin {margin:.3f} < 0.3 — the echo metric does not separate the "
        f"reframed vs naive arms enough to prove it is red-capable on Gemini. "
        f"naive={j_naive:.3f}, postfix={j_post:.3f}"
    )


# ---------------------------------------------------------------------------
# Structural: Gemini's transcript surfaces as an assistant text part, and the
# shared reframe is what protects it (no marker key leaks — AC11 parallel).
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_gemini_transcript_surfaces_as_assistant_text_part():
    """The Gemini adapter's recv_audio transcript lands as a text part on the
    assistant turn in result.messages (this is the part the shared reframe
    protects). Also: no 'scenario_origin' marker key leaks into messages.
    """
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
        f"Expected the Gemini assistant turn to surface transcript text "
        f"{QUESTION!r} as a text part. Messages: {result.messages}"
    )

    dumped = json.dumps([dict(m) for m in result.messages])
    assert "scenario_origin" not in dumped, (
        "Marker key 'scenario_origin' leaked into result.messages"
    )
