"""
ElevenLabsAgentAdapter: connect to ElevenLabs Conversational AI via their WebSocket.

Source §5.4. Endpoint: wss://api.elevenlabs.io/v1/convai/conversation?agent_id=...
Exchanges PCM16 audio chunks.

Wire protocol:
- Send:
  - JSON ``{"user_audio_chunk": "<base64 PCM16>"}`` — the default
    ``"audio"`` turn-commit path. The continuous pump feeds the user's real
    PCM as 20 ms frames at microphone cadence, then unbounded closing
    silence; EL's server VAD closes the turn on that audio→silence
    transition. This is the only path on which the agent's own STT and VAD
    run against the user's voice.
  - JSON ``{"type": "user_message", "text": "<transcript>"}`` — the opt-in
    ``"text"`` turn-commit path. Deterministically commits a turn without
    server VAD, but sends NO audio, so EL's STT never runs. EL ConvAI
    exposes no audio-flush / end-of-turn client event (verified against the
    official EL Python + JS SDKs), which is why this escape hatch exists at
    all. See ``send_audio`` and ``TurnCommitMode``.
- Recv events:
  - ``conversation_initiation_metadata`` — checked for audio-format
    mismatch against advertised capability; warning logged on drift
  - ``user_transcript`` / ``agent_response`` — text captured on
    ``last_user_transcript`` / ``last_agent_transcript`` for observability
  - ``agent_response_correction`` — corrected text replaces
    ``last_agent_transcript`` (post-barge-in update)
  - ``audio`` — decoded and returned from ``recv_audio``
  - ``ping`` — replied to with ``{"type": "pong", "event_id": <id>}``
  - ``client_tool_call`` — tool-only / non-audio terminal turn: ends the
    drain with an empty ``AudioChunk`` (issue #648) instead of hanging to
    the ``response_timeout`` deadline. The adapter has no
    ``client_tool_result`` path, so the agent cannot follow up with audio.
  - ``interruption`` — swallowed
  - Other documented events (``vad_score``, ``agent_response_metadata``,
    etc.) — silently skipped; the provisioned test agent doesn't trigger them.

A socket close mid-receive is also treated as a terminal: ``recv_audio``
returns an empty ``AudioChunk`` so the drain exits cleanly (issue #648).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from collections import deque
from typing import Any, ClassVar, Deque, Final, Literal, Optional

from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities


logger = logging.getLogger("scenario.voice.elevenlabs")

CONVAI_URL_TEMPLATE = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}"

#: Zero-byte silence-tail length for the ``"silence"`` turn-commit path. 16000
#: zero bytes at pcm_24000 = ~333 ms of silence — the empirical middle ground
#: that historically let the *greeting → first user turn* exchange work.
#:
#: A BOUNDED tail is what made scripted turn 2+ unreliable (issue #567): EL
#: ConvAI 2.0's end-of-turn is a hybrid VAD + deep-learning turn-detector, not a
#: pure silence threshold, so a fixed zero-byte blob does not deterministically
#: trip it. The default ``"audio"`` mode drops the bound entirely — the pump
#: streams closing silence until the agent actually responds — which is what
#: makes real voice-in work across turns. This constant only applies to the
#: opt-in ``"silence"`` mode.
SILENCE_TAIL_BYTES = 16000

#: Absolute wall-clock ceiling (seconds) for a single :meth:`recv_audio` call
#: that keepalive pings do NOT reset. The idle deadline is re-armed on every
#: inbound frame, pings included (#649), so a slow-but-pinging server is not
#: aborted mid-think — but EL ConvAI pings *indefinitely* on a turn it will
#: never answer with audio (e.g. after it ends/transfers its turn), which would
#: otherwise wedge the whole multi-turn run (issue #829; the absolute backstop
#: explicitly deferred in #493). 45s is generous enough for a genuinely slow
#: agent to respond, but finite so a non-responding turn times out cleanly.
KEEPALIVE_HARD_CEILING_S: Final[float] = 45.0

#: Deep link to the section that expands on both recv_audio timeouts.
RECEIVE_TIMEOUT_DOCS_URL: Final[str] = (
    "https://scenario.langwatch.ai/voice/troubleshooting"
    "#receiveaudio-timed-out-hosted-elevenlabs"
)


def _seconds(value: float) -> str:
    """Render a seconds value the way the TypeScript adapter's template literal
    does, so both SDKs print ``60s`` and ``0.6s`` rather than ``60.0s``."""
    return f"{value:g}"


def _idle_timeout_message(timeout_s: float) -> str:
    """Rejection text for the IDLE deadline: nothing at all reached the socket,
    not even a keepalive ping, for ``timeout_s`` seconds. A fully silent agent.

    Distinct from :func:`_ceiling_timeout_message` on purpose: silence and
    pings-but-no-audio are different diagnoses with different remedies, so one
    shared message would send the reader to check the wrong things.
    """
    waited = _seconds(timeout_s)
    return (
        f"ElevenLabsAgentAdapter: recv_audio timed out. The idle deadline of "
        f"{waited}s elapsed with no message of any kind from the hosted agent, "
        f"not even a keepalive ping. For a scripted multi-turn run this usually "
        f"means the agent ended or transferred its turn (e.g. an escalation/handoff "
        f"request), or the user turn did not commit. If the agent is only slower "
        f"than that, raise the adapter's response_timeout, currently {waited}s, "
        f"for example adapter.response_timeout = 180. See {RECEIVE_TIMEOUT_DOCS_URL}"
    )


def _ceiling_timeout_message(timeout_s: float, ceiling_s: float) -> str:
    """Rejection text for the ABSOLUTE ceiling: the agent kept the socket alive
    with keepalive pings, which re-arm the idle deadline, but never sent audio.
    """
    floor = _seconds(KEEPALIVE_HARD_CEILING_S)
    return (
        f"ElevenLabsAgentAdapter: recv_audio timed out. The absolute ceiling of "
        f"{_seconds(ceiling_s)}s elapsed while the hosted agent kept the socket "
        f"alive with keepalive pings but never sent audio. Pings re-arm the idle "
        f"deadline, so this ceiling, max(response_timeout, {floor}s), is what "
        f"bounds the wait. It usually means a wedged server tool or retrieval call, "
        f"or an agent that ended or transferred its turn. If the agent is only "
        f"slower than that, raise the adapter's response_timeout, currently "
        f"{_seconds(timeout_s)}s, past {floor}s and the ceiling rises with it, "
        f"for example adapter.response_timeout = 180. "
        f"See {RECEIVE_TIMEOUT_DOCS_URL}"
    )


#: How :meth:`ElevenLabsAgentAdapter.send_audio` signals end-of-turn to EL ConvAI.
#:
#: - ``"audio"`` (default): stream the turn's real PCM as 20 ms
#:   ``user_audio_chunk`` frames at microphone cadence and let the pump's
#:   *unbounded* closing silence carry the audio→silence transition EL's server
#:   VAD measures end-of-turn against. This is the only mode in which the
#:   agent-under-test's own STT and VAD actually run on the user's voice, so it
#:   is what a voice test must default to. Mirrors the TS adapter (#707).
#: - ``"text"``: send an explicit
#:   ``{"type": "user_message", "text": <transcript>}`` and send NO audio. This
#:   deterministically commits a turn without relying on server VAD, but the
#:   agent never hears the user — its STT and VAD are bypassed entirely, so a
#:   passing run says nothing about either. Kept as an opt-in escape hatch for
#:   agents whose turn-taking cannot be driven by scripted audio; requires a
#:   transcript on the outgoing :class:`AudioChunk` and falls back to
#:   ``"silence"`` when absent.
#: - ``"silence"``: stream the audio then a fixed ``silence_tail_bytes``
#:   zero-byte tail. The pre-pump behaviour, retained for callers pinned to a
#:   bounded tail; ``"audio"`` supersedes it.
TurnCommitMode = Literal["audio", "text", "silence"]

#: One continuous-mic pump frame = 20 ms of PCM. Fixed at 960 bytes to match the
#: TS reference (``PUMP_FRAME_BYTES``, ``adapters/elevenlabs.ts:107``); the pump
#: only ever writes fixed-size frames so EL's server VAD sees a steady cadence.
PUMP_FRAME_BYTES = 960

#: Pump cadence (seconds): one :data:`PUMP_FRAME_BYTES` frame every 20 ms — real
#: microphone cadence. Mirrors TS ``PUMP_INTERVAL_MS = 20``
#: (``adapters/elevenlabs.ts:117``).
PUMP_INTERVAL_S = 0.02

#: The all-zero (silence) 20 ms frame. When the outbound queue is empty AND the
#: user turn is still closing (before the agent responds), the pump feeds this so
#: EL's server VAD has the audio→silence transition it measures end-of-turn
#: against. Mirrors TS ``SILENCE_FRAME`` (``adapters/elevenlabs.ts:144``).
SILENCE_FRAME = b"\x00" * PUMP_FRAME_BYTES

#: Wall-clock budget for one turn-boundary reconcile sweep. Long enough to
#: recover a burst already in flight, short enough that a turn boundary never
#: visibly stalls. See ``reconcile_pending_audio``.
RECONCILE_BUDGET_S: Final[float] = 0.4

#: Per-poll idle timeout inside a reconcile sweep. Once this much time passes
#: with nothing arriving, the prior turn really is finished.
RECONCILE_POLL_S: Final[float] = 0.12

#: EL system tools whose successful invocation means the AGENT ended the call,
#: so the socket close that follows is deliberate rather than a dropped
#: transport (issue #839). ``transfer_to_*`` also hands the caller off and ends
#: this session, so it is a hangup from the harness's point of view.
HANGUP_TOOL_NAMES: Final[frozenset[str]] = frozenset(
    {"end_call", "transfer_to_agent", "transfer_to_number", "transfer_to_genesys"}
)


def _deep_merge(
    base: dict[str, Any], layer: dict[str, Any]
) -> dict[str, Any]:
    """Recursively merge ``layer`` ON TOP OF ``base``, returning a NEW dict
    (neither argument is mutated).

    When a key holds a dict on BOTH sides the two are merged key-by-key, so a
    shared parent like ``agent`` keeps keys from both; for every other shape —
    scalar, list, or a key present on only one side — ``layer`` wins where it
    supplies the key, else ``base``'s value is kept.

    This is the precedence engine for ``conversation_config_override``: the
    caller's ``overrides`` are the ``base`` and the adapter's narrow
    ``{"agent": {"prompt", "first_message"}}`` is the ``layer``, so the narrow
    knobs win on a shared LEAF while sibling caller keys (``agent.language``, a
    top-level ``tts``) survive intact. A shallow ``{**base, **layer}`` would
    instead DROP one side's nested ``agent``. Mirrors the TS ``deepMerge``
    (``adapters/elevenlabs.ts:202``).
    """
    out = dict(base)
    for key, layer_value in layer.items():
        base_value = out.get(key)
        if isinstance(base_value, dict) and isinstance(layer_value, dict):
            out[key] = _deep_merge(base_value, layer_value)
        else:
            out[key] = layer_value
    return out


class ElevenLabsAgentAdapter(VoiceAgentAdapter):
    """
    ElevenLabs **hosted** Conversational AI adapter.

    Connects to ElevenLabs' hosted endpoint where the STT→LLM→TTS loop runs
    on their infrastructure. All audio is PCM16 @ 24kHz mono — no conversion
    needed at either edge.

    Not to be confused with :class:`ElevenLabsVoiceAgent` (in
    ``scenario.voice.adapters.composable``), which is the typed composable
    preset that runs locally with separate STT, LLM, and TTS providers. The
    two complement each other:

    - ``ElevenLabsAgentAdapter`` (this class): black-box hosted EL ConvAI;
      you provide an ``agent_id`` provisioned in the EL dashboard and EL
      runs the whole pipeline server-side.
    - :class:`ElevenLabsVoiceAgent`: composes ``ElevenLabsSTTProvider`` +
      any LLM + ElevenLabs TTS on your side; you control the prompts,
      model choice, and tool calls.

    Intermediate transcripts are tracked on ``last_user_transcript`` and
    ``last_agent_transcript`` for scenario observability.

    Example::

        adapter = ElevenLabsAgentAdapter(agent_id="abc123", api_key="sk-...")
        async with adapter:
            # scenario.run() feeds send_audio / recv_audio ...
    """

    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities(
        streaming_transcripts=True,
        native_vad=True,
        dtmf=False,
        input_formats=["pcm16/24000"],
        output_formats=["pcm16/24000"],
    )

    def __init__(
        self,
        agent_id: str,
        api_key: str,
        *,
        system_prompt_override: Optional[str] = None,
        first_message_override: Optional[str] = None,
        dynamic_variables: Optional[dict[str, Any]] = None,
        overrides: Optional[dict[str, Any]] = None,
        turn_commit_mode: TurnCommitMode = "audio",
        silence_tail_bytes: int = SILENCE_TAIL_BYTES,
    ) -> None:
        super().__init__()
        self.agent_id = agent_id
        self._api_key = api_key
        # Per-session overrides applied via conversation_initiation_client_data
        # at the start of every WS connect. Used by demos that need a
        # different prompt shape (e.g. verbose for interrupt demos) without
        # mutating the shared test agent's persistent config.
        #
        # WARNING (issue #838): ``system_prompt_override`` replaces the agent's
        # ENTIRE prompt object server-side, ``tool_ids`` included. A hosted
        # agent that relies on server tools silently loses them and then stalls
        # waiting for tool responses that can never arrive. To personalise a
        # deployed agent without dropping its tools, use ``dynamic_variables``
        # (fills the deployed prompt template) plus a narrow ``overrides``
        # entry, and leave the prompt alone.
        self._system_prompt_override = system_prompt_override
        self._first_message_override = first_message_override
        #: Per-call dynamic variables, forwarded natively as the init
        #: handshake's ``dynamic_variables``. EL personalises a hosted agent per
        #: call from these. Values keep their JSON type — str / int / float /
        #: bool — with NO ``str()`` coercion, matching EL's typed support.
        #: Applied only if the agent declares them (server-side allowlist).
        #: When unset, no ``dynamic_variables`` key is sent at all (not ``{}``).
        self._dynamic_variables = dynamic_variables
        #: Per-call conversation-config overrides, DEEP-merged UNDER the narrow
        #: prompt/first-message knobs above. Use for anything those do not cover
        #: (e.g. ``{"agent": {"language": "es"}, "tts": {"stability": 0.3}}``).
        #: Applied only if the agent allowlists the key server-side.
        self._overrides = overrides
        # How a user turn is committed. Defaults to ``"audio"``: the turn's real
        # PCM goes on the wire and the pump's unbounded closing silence closes
        # the turn, so the agent's own STT and VAD run on the user's voice.
        # ``"text"`` and ``"silence"`` are opt-in. See ``TurnCommitMode``.
        if turn_commit_mode not in ("audio", "text", "silence"):
            raise ValueError(
                f"Unknown turn_commit_mode: {turn_commit_mode!r}. "
                'Expected "audio", "text" or "silence".'
            )
        if not isinstance(silence_tail_bytes, int) or silence_tail_bytes <= 0:
            raise ValueError(
                f"silence_tail_bytes must be a positive integer, got {silence_tail_bytes!r}."
            )
        self._turn_commit_mode: TurnCommitMode = turn_commit_mode
        # Zero-byte silence-tail length, consulted only on the ``"silence"``
        # path (and the ``"text"`` fallback when no transcript is available).
        self._silence_tail_bytes = silence_tail_bytes
        self._ws: Any = None

        # ---- continuous mic pump state ----
        # The pump is the SINGLE owner of idle silence on the wire: a
        # background task ticks every :data:`PUMP_INTERVAL_S` and feeds one
        # 20 ms frame — queued speech while the user is talking, the closing
        # SILENCE_FRAME while the turn is still closing, and NOTHING once the
        # agent has responded (the post-response pause, #705). Mirrors the TS
        # pump (``adapters/elevenlabs.ts:563-668``), adapted to Python's raw-WS
        # send seam (there is no ``inputCallback`` SDK seam here).
        self._pump_task: Optional[asyncio.Task[None]] = None
        self._outbound_frames: Deque[bytes] = deque()
        #: SET when agent audio begins (pauses the idle mic so EL's idle prompt
        #: never trips); CLEARED when a new user turn is enqueued.
        self.awaiting_user_turn: bool = False

        # Transcript observability — updated on each transcript event.
        self.last_user_transcript: Optional[str] = None
        self.last_agent_transcript: Optional[str] = None

        #: How many user turns were committed as REAL audio. Counted once per
        #: non-empty :meth:`enqueue_speech`, not per 20 ms frame, so it counts
        #: turns. Lets a test assert the agent actually heard the user rather
        #: than merely replying (mirror TS ``audioCommitCount``).
        self.audio_commit_count: int = 0

    @property
    def url(self) -> str:
        return CONVAI_URL_TEMPLATE.format(agent_id=self.agent_id)

    def __repr__(self) -> str:  # redact credentials
        return f"ElevenLabsAgentAdapter(agent_id={self.agent_id!r}, api_key='***')"  # noqa: S105

    # ------------------------------------------------------------------ lifecycle

    async def connect(self) -> None:
        """Open the WebSocket to ElevenLabs' ConvAI endpoint.

        We send ``conversation_initiation_client_data`` on every connect.
        The EL docs neither require nor forbid this (the reference SDK
        sample sends it unconditionally with an empty body); empirically
        we've seen ``first_message`` skipped on bare connects and reliably
        fire when the init message is sent, even with an empty override
        block. If EL's behavior changes, this is the first thing to
        revisit.
        """
        import websockets

        self._ws = await websockets.connect(
            self.url,
            additional_headers={"xi-api-key": self._api_key},
        )
        logger.debug("ElevenLabsAgentAdapter: connected to %s", self.url)

        # Stamp EL-specific attrs onto the active ``voice.adapter.connect`` span
        # (opened by the executor connect loop). Base spans are name-owned; the
        # adapter contributes attributes, never a parallel span name.
        from opentelemetry import trace as _otel_trace
        from .._telemetry import set_span_attributes

        set_span_attributes(
            _otel_trace.get_current_span(),
            {"voice.elevenlabs.agent_id": self.agent_id},
        )

        # The NARROW prompt/first-message knobs build an `agent` override that is
        # always sent (an empty `agent` object is a no-op) so the handshake shape
        # is stable; it carries the overrides when set.
        agent_override: dict[str, Any] = {}
        if self._system_prompt_override:
            agent_override["prompt"] = {"prompt": self._system_prompt_override}
        if self._first_message_override:
            agent_override["first_message"] = self._first_message_override

        # DEEP-merge the caller's `overrides` (the base, lower precedence) UNDER
        # the narrow `{"agent": agent_override}` (the layer, higher precedence),
        # so a caller's `agent.language` and our `agent.prompt` BOTH survive.
        conversation_config_override = _deep_merge(
            self._overrides or {}, {"agent": agent_override}
        )

        init: dict[str, Any] = {
            "type": "conversation_initiation_client_data",
            "conversation_config_override": conversation_config_override,
        }
        # Omit the key entirely when unset — EL treats an empty object
        # differently from an absent one.
        if self._dynamic_variables is not None:
            init["dynamic_variables"] = self._dynamic_variables
        await self._ws.send(json.dumps(init))
        logger.debug(
            "ElevenLabsAgentAdapter: sent conversation_initiation_client_data "
            "with config_override_keys=%s dynamic_variables=%s",
            sorted(conversation_config_override.keys()) or "none",
            sorted(self._dynamic_variables.keys())
            if self._dynamic_variables
            else "none",
        )

        # Start the continuous mic pump now that the socket is open, so the
        # interval never outlives the socket (mirror ``onAudioStart`` →
        # ``startPump``, ``adapters/elevenlabs.ts:497,563``).
        self.start_pump()

    def is_connected(self) -> bool:
        """Whether the WS session is open and ready to exchange audio.

        The websockets-lib equivalent of the TS
        ``conversation?.isSessionActive()`` check
        (``adapters/elevenlabs.ts:531-534``): open iff we hold a socket that
        is not closed.

        Liveness is read from the connection ``state`` on modern
        ``websockets`` (>=13, the ``websockets.asyncio.client.ClientConnection``
        that :func:`websockets.connect` returns) — that class exposes a
        ``state`` enum, NOT a ``closed`` attribute. We fall back to ``closed``
        for the legacy ``WebSocketClientProtocol`` and for in-memory test
        doubles that model ``closed``. Note ``is_connected()`` is a
        best-effort *hint* for the pre-turn guard and the pump active-check;
        it is never the sole guard on a send — the pump's send is wrapped in a
        raced-close swallow, and ``recv_audio`` still handles ``ConnectionClosed``
        directly, because a socket can drop between this check and the I/O.
        """
        ws = self._ws
        if ws is None:
            return False
        state = getattr(ws, "state", None)
        if state is not None:
            # Modern websockets: OPEN iff state is OPEN. CONNECTING/CLOSING/
            # CLOSED all read as not-ready for a turn.
            try:
                from websockets.protocol import State

                return state is State.OPEN
            except Exception:
                # State enum unavailable — compare by name as a last resort.
                return getattr(state, "name", "") == "OPEN"
        # Legacy protocol / test double exposing `closed`.
        return not getattr(ws, "closed", False)

    async def disconnect(self) -> None:
        """Close the WebSocket if open.

        The pump is stopped and awaited FIRST (mirror TS ``disconnect`` stop-
        before-close, ``adapters/elevenlabs.ts:539``) so no frame is fed once
        teardown begins — even if disconnect() races a close/error that has
        already nulled the socket.
        """
        await self.stop_pump()
        # Stamp pump counters onto the active ``voice.adapter.disconnect`` span
        # (the pump has no per-tick span — H1). Read before the socket teardown.
        _stats = getattr(self, "_pump_stats", None)
        if _stats is not None:
            from opentelemetry import trace as _otel_trace
            from .._telemetry import set_span_attributes

            set_span_attributes(
                _otel_trace.get_current_span(),
                {
                    "voice.elevenlabs.pump.ticks_total": _stats.get("ticks_total", 0),
                    "voice.elevenlabs.pump.speech_frames_sent": _stats.get(
                        "speech_frames_sent", 0
                    ),
                    "voice.elevenlabs.pump.silence_frames_sent": _stats.get(
                        "silence_frames_sent", 0
                    ),
                    "voice.elevenlabs.pump.unexpected_errors": _stats.get(
                        "unexpected_errors", 0
                    ),
                },
            )
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                # Best-effort: connection may already be half-closed or
                # in an error state when disconnect() is called. We're
                # tearing down regardless — propagating here would just
                # leak the WS reference.
                pass
            finally:
                self._ws = None
            logger.debug("ElevenLabsAgentAdapter: disconnected")

    # ------------------------------------------------------- continuous mic pump

    def start_pump(self) -> None:
        """Start the continuous mic pump. Idempotent — a double call yields
        exactly one running task (mirror ``startPump``,
        ``adapters/elevenlabs.ts:588-595``)."""
        if self._pump_task is None or self._pump_task.done():
            # Fresh per-pump-lifetime counters (surfaced on voice.adapter.disconnect;
            # the 20 ms pump gets NO per-tick span — its OTel context is frozen at
            # task creation, so a per-tick span would misparent + flood).
            self._pump_stats = {
                "ticks_total": 0,
                "speech_frames_sent": 0,
                "silence_frames_sent": 0,
                "unexpected_errors": 0,
            }
            self._pump_task = asyncio.ensure_future(self._pump_loop())

    async def stop_pump(self) -> None:
        """Stop the pump, drop any unsent frames, and reset the post-response
        pause so a reconnect starts in the closing-silence state.

        Cancels AND awaits the task so no orphan is left pending at loop close
        (mirror ``stopPump``, ``adapters/elevenlabs.ts:601-612``).
        """
        task = self._pump_task
        self._pump_task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                # Expected: awaiting a just-cancelled task re-raises the
                # CancelledError here. Intentionally suppressed — we requested
                # the cancel as part of an orderly pump shutdown.
                pass
        self._outbound_frames.clear()
        # Reset the post-response pause so a reconnect starts in the
        # closing-silence state — the next user turn streams its silence again.
        self.awaiting_user_turn = False

    async def _pump_loop(self) -> None:
        """Tick every :data:`PUMP_INTERVAL_S` until cancelled."""
        while True:
            await asyncio.sleep(PUMP_INTERVAL_S)
            await self._pump_tick()

    async def _pump_tick(self) -> None:
        """One pump tick — one of three outcomes, gated on the session being
        active so a frame that races a close cannot reach a dead socket
        (mirror ``pumpTick``, ``adapters/elevenlabs.ts:640-668``):

        * QUEUED SPEECH present → feed it (the user is speaking).
        * else AWAITING the next user turn (:attr:`awaiting_user_turn`) → feed
          NOTHING this tick (the #705 post-response pause, so EL's idle prompt
          never trips in the inter-turn gap).
        * else → feed one :data:`SILENCE_FRAME`: the closing silence after the
          user's speech, which EL's server VAD measures end-of-turn against.
        """
        if not self.is_connected():
            return

        _stats = getattr(self, "_pump_stats", None)
        if _stats is not None:
            _stats["ticks_total"] += 1

        if self._outbound_frames:
            frame = self._outbound_frames.popleft()
            if _stats is not None:
                _stats["speech_frames_sent"] += 1
        elif self.awaiting_user_turn:
            return
        else:
            frame = SILENCE_FRAME
            if _stats is not None:
                _stats["silence_frames_sent"] += 1

        import websockets  # for the ConnectionClosed close-race classes

        try:
            b64 = base64.b64encode(frame).decode()
            await self._ws.send(json.dumps({"user_audio_chunk": b64}))
        except (
            websockets.exceptions.ConnectionClosed,
            ConnectionError,
            OSError,
            RuntimeError,
        ):
            # The EXPECTED close race: the socket closed between the
            # active-check above and this feed. Drop the frame; the
            # disconnect/close path tears the pump down (mirror the raced-close
            # swallow, ``adapters/elevenlabs.ts:661-663``).
            logger.debug("ElevenLabsAgentAdapter: pump tick raced a close; frame dropped")
        except Exception:  # noqa: BLE001 — background task must never propagate
            # An UNEXPECTED failure (serialization/protocol bug, not a close
            # race). Do NOT silently swallow it as a close: surface it at
            # WARNING so the bug is visible, but still don't propagate out of
            # the background task (that would kill the pump loop and leave an
            # unhandled-task exception). The next tick retries.
            if _stats is not None:
                _stats["unexpected_errors"] += 1
            logger.warning(
                "ElevenLabsAgentAdapter: unexpected error feeding pump frame; "
                "dropping frame and continuing",
                exc_info=True,
            )

    def enqueue_speech(self, data: bytes) -> None:
        """Slice a user turn's PCM into fixed 20 ms frames and enqueue them for
        the pump; a non-empty turn also CLEARS :attr:`awaiting_user_turn` (a new
        user turn is starting, so the closing silence must stream again once the
        speech drains). Mirror ``enqueueSpeech``,
        ``adapters/elevenlabs.ts:703-731``.
        """
        if not data:
            # An empty chunk carries no speech: don't count it as a real-audio
            # turn, don't disturb the pause, don't enqueue a meaningless frame.
            return
        # A real user turn is starting → lift the post-response pause.
        self.awaiting_user_turn = False
        # Count the turn ONCE per non-empty call (not once per 20 ms frame) so
        # the counter still counts turns.
        self.audio_commit_count += 1
        for offset in range(0, len(data), PUMP_FRAME_BYTES):
            slice_ = data[offset : offset + PUMP_FRAME_BYTES]
            if len(slice_) < PUMP_FRAME_BYTES:
                # Pad the final partial frame to a full 20 ms with trailing
                # zeros so the pump only ever feeds fixed-size frames.
                slice_ = slice_ + b"\x00" * (PUMP_FRAME_BYTES - len(slice_))
            self._outbound_frames.append(slice_)

    async def reconcile_pending_audio(self) -> Optional[AudioChunk]:
        """Collect agent audio still in flight at a user-turn boundary.

        The drain closes a turn on ``response_tail_silence``. EL delivers audio
        in bursts, so a mid-utterance delivery gap longer than that silence ends
        the turn while the agent is still speaking. Left alone, the remainder is
        read by the NEXT drain and surfaces as the next agent turn's opening
        audio — an answer to the previous question attributed to the current one
        (the split-utterance bleed, issue #749; fixed for TypeScript in #748).

        Called at the pre-user-``send_audio`` boundary and never while a drain is
        in flight. At that instant the agent cannot have begun its next reply —
        the user has not spoken yet — so anything still arriving is unambiguously
        leftover from the PRIOR agent turn. That is what makes attributing it
        backwards safe.

        Bounded by :data:`RECONCILE_BUDGET_S` of wall clock so a turn boundary
        never stalls: this recovers the burst already on the wire, it does not
        wait out a slow agent.

        Duck-typed convention (symmetric with ``last_agent_transcript``): the
        shared runtime feature-detects this method, so adapters without buffered
        audio are untouched.
        """
        if not self.is_connected():
            return None
        collected: list[bytes] = []
        loop = asyncio.get_running_loop()
        deadline = loop.time() + RECONCILE_BUDGET_S
        while loop.time() < deadline:
            try:
                chunk = await asyncio.wait_for(
                    self.recv_audio(timeout=RECONCILE_POLL_S),
                    timeout=max(RECONCILE_POLL_S, deadline - loop.time()),
                )
            except asyncio.TimeoutError:
                # Nothing more immediately available — the prior turn is done.
                break
            except Exception:  # noqa: BLE001 — best-effort sweep
                # The socket went away mid-reconcile, or the transport raised.
                # This is opportunistic cleanup at a turn boundary; surface it
                # but never fail the turn over it.
                logger.debug(
                    "ElevenLabsAgentAdapter: reconcile sweep ended on transport "
                    "error; keeping what was collected",
                    exc_info=True,
                )
                break
            if not chunk.data:
                break
            collected.append(chunk.data)
        if not collected:
            return None
        return AudioChunk(data=b"".join(collected))

    def _on_agent_audio_begin(self) -> None:
        """Agent turn audio has arrived → engage the post-response pause: the
        pump stops streaming idle silence until the next user turn. Idempotent —
        the first agent frame is the real transition; later frames re-assert it
        (mirror ``onAgentAudio`` setting ``awaitingUserTurn``,
        ``adapters/elevenlabs.ts:513-514``).
        """
        self.awaiting_user_turn = True

    # ------------------------------------------------------------------ I/O

    async def send_audio(self, chunk: AudioChunk) -> None:
        """Commit a user turn to EL ConvAI.

        EL ConvAI exposes NO audio-flush / end-of-turn client event (verified
        against the official EL Python + JS SDKs — the full client→server union
        is pong | client_tool_result | conversation_initiation_client_data |
        feedback | contextual_update | user_message | user_activity |
        multimodal_message, plus the bare user_audio_chunk; none commit audio).
        Server-side turn detection (ConvAI 2.0 hybrid VAD + DL turn-detector)
        does NOT reliably fire on a scripted, non-mic stream, so the legacy
        "stream audio + silence tail" path stalls on turn 2+ (issue #567).

        Three commit modes (see ``TurnCommitMode``):

        - ``"audio"`` (default): enqueue the turn's real PCM for the pump and
          stop. The pump feeds it as 20 ms ``user_audio_chunk`` frames at
          microphone cadence, then streams *unbounded* closing silence until
          the agent responds — the audio→silence transition EL's server VAD
          measures end-of-turn against. No bounded tail to tune. This is the
          only mode that puts the user's voice on the wire, so it is the only
          mode in which the agent's own STT and VAD are exercised.
        - ``"text"``: send ONLY ``{"type": "user_message", "text": …}``. The
          audio is DISCARDED — EL's STT never runs and a green run proves
          nothing about the agent's transcription or turn-taking. Opt-in only,
          for agents whose turn-taking cannot be driven by scripted audio.
        - ``"silence"``: stream the speech then a fixed ``silence_tail_bytes``
          zero-byte tail. Superseded by ``"audio"``'s unbounded closing
          silence; retained for callers pinned to a bounded tail.

        Silence-tail size rationale (``"silence"`` path): 16000 zero bytes at
        pcm_24000 = ~333ms — empirically the sweet spot for the greeting →
        first-turn exchange. Removing it entirely, or doubling to 24000, both
        reproduced the stall pattern.
        """
        if self._ws is None:
            raise RuntimeError("ElevenLabsAgentAdapter: not connected")

        transcript = chunk.transcript.strip() if chunk.transcript else ""

        # A real user turn is starting → lift the post-response pause so the
        # pump streams the closing silence again after this turn (mirror
        # ``enqueueSpeech`` clearing ``awaitingUserTurn``,
        # ``adapters/elevenlabs.ts:710``). Empty chunks carry no turn.
        if transcript or chunk.data:
            self.awaiting_user_turn = False

        if self._turn_commit_mode == "text" and transcript:
            # Text-only commit: no user_audio_chunk is sent, so EL's STT never
            # sees this turn. See ``TurnCommitMode`` for why this is opt-in.
            await self._send_user_message(transcript)
            return

        # The pump is the SINGLE owner of WS audio writes: rather than writing
        # `chunk.data` DIRECTLY to `self._ws` (which would race the always-
        # running background pump — two concurrent writers producing
        # interleaved/oversized non-20ms `user_audio_chunk` frames), we ENQUEUE
        # the speech as fixed 960-byte pump frames. The pump drains them at the
        # same 20ms cadence as every other frame, so there is exactly one writer
        # and a consistent frame size on the wire. Returns promptly
        # (continuous-mic model) — it does not block until the queue drains.
        self.enqueue_speech(chunk.data)
        if self._turn_commit_mode != "audio":
            # "silence" (and the "text" fallback when a chunk carries no
            # transcript): append the bounded legacy tail. On the "audio" path
            # the pump's unbounded closing silence already provides the
            # end-of-turn transition, so a fixed tail would only cap it.
            self._enqueue_silence_tail()

    async def _send_user_message(self, text: str) -> None:
        """Explicit turn-commit: tell EL the user is done and force an agent
        response without relying on mic-style server VAD (issue #567). Wire
        shape matches the official SDK's ``user_message`` event.

        This is a single control frame (`user_message`), not streamed audio,
        so it does not contend with the pump's `user_audio_chunk` cadence.
        """
        await self._ws.send(json.dumps({"type": "user_message", "text": text}))

    def _enqueue_silence_tail(self) -> None:
        """Queue the legacy closing-silence tail as fixed 960-byte pump frames.

        The legacy path coaxed server VAD with a fixed ``_silence_tail_bytes``
        zero-byte blob written directly to the socket. To keep the pump the
        single WS writer, express that same total silence as
        ``ceil(_silence_tail_bytes / PUMP_FRAME_BYTES)`` all-zero 960-byte pump
        frames on the outbound queue, drained at the 20ms cadence. Rounds UP so
        the emitted silence is never less than the legacy tail.
        """
        num_frames = -(-self._silence_tail_bytes // PUMP_FRAME_BYTES)  # ceil div
        for _ in range(num_frames):
            self._outbound_frames.append(SILENCE_FRAME)

    async def recv_audio(self, timeout: float) -> AudioChunk:
        """
        Receive the next audio chunk from ElevenLabs.

        ``timeout`` bounds **inter-message silence** — the maximum gap between
        any two received frames — NOT the total duration of the call. Every
        received frame (**keep-alive pings included**) resets the idle
        deadline, so this returns when an ``audio`` event arrives and raises
        :class:`asyncio.TimeoutError` only after ``timeout`` seconds elapse
        with **no message of any kind**. Pings are replied to inline;
        transcript events update instance attributes for observability; most
        other event types are swallowed without error.

        Terminal (non-audio) completions return an **empty** ``AudioChunk``
        rather than hanging to the deadline (issue #648): a ``client_tool_call``
        (tool-only turn — this adapter has no ``client_tool_result`` path) and a
        socket close mid-receive both end the drain cleanly, mirroring the
        #646/PR647 reference fix and the Gemini Live / Pipecat idiom.

        Design decision (issue #493 — intentional, not an oversight): because
        a received ping is treated as proof of liveness, a hosted agent that
        keeps pinging but never sends audio (e.g. a wedged tool/RAG call) will
        make this method wait past ``timeout``. A legitimate 30s+
        silent-but-pinging stretch must not abort the turn, which a cumulative
        budget would do — so pings keep re-arming the idle deadline below.
        But EL ConvAI can also ping *indefinitely* on a turn it will never
        answer with audio (e.g. after it ends/transfers its turn), which would
        otherwise wedge the whole multi-turn run forever. To bound that case
        without punishing a merely slow agent, :data:`KEEPALIVE_HARD_CEILING_S`
        sets an absolute wall-clock ceiling, computed ONCE per call and NOT
        reset by pings (issue #829; the backstop explicitly deferred in #493).
        The caller's ``response_max_duration`` is checked *between*
        ``recv_audio`` calls and does **not** bound a single in-progress recv.
        """
        import websockets  # for the ConnectionClosed terminal (issue #648)

        if self._ws is None:
            raise RuntimeError("ElevenLabsAgentAdapter: not connected")

        start = asyncio.get_running_loop().time()
        deadline = start + timeout
        # Absolute wall-clock ceiling that keepalive pings do NOT reset (#829 /
        # the deferred #493 backstop). EL ConvAI pings indefinitely on a turn it
        # will never answer with audio (e.g. after it ends or transfers its
        # turn); with only the ping-resettable idle ``deadline`` this loop would
        # wedge forever. The ceiling bounds that pings-but-no-audio case. At
        # least ``timeout`` so it never pre-empts the idle deadline.
        ceiling = max(timeout, KEEPALIVE_HARD_CEILING_S)
        hard_deadline = start + ceiling
        # Whether ANY inbound frame arrived. It is what tells the two rejections
        # apart when both bounds land on the same instant, which is the default
        # case: idle 60s, ceiling max(60, 45) = 60s. Nothing received means the
        # socket was silent throughout, so the idle diagnosis is the true one.
        saw_inbound_frame = False

        def timeout_error() -> asyncio.TimeoutError:
            """The rejection for whichever bound expired. A socket that went
            completely quiet and one that pings steadily without ever speaking
            are different problems, so they get different messages."""
            if saw_inbound_frame and hard_deadline <= deadline:
                return asyncio.TimeoutError(_ceiling_timeout_message(timeout, ceiling))
            return asyncio.TimeoutError(_idle_timeout_message(timeout))

        while True:
            now = asyncio.get_running_loop().time()
            remaining = min(deadline, hard_deadline) - now
            if remaining <= 0:
                raise timeout_error()

            try:
                raw = await asyncio.wait_for(self._ws.recv(), timeout=remaining)
            except asyncio.TimeoutError as err:
                # ``wait_for`` raises a bare TimeoutError with an empty message,
                # which is how both bounds used to reach the caller indistinguishable.
                raise timeout_error() from err
            except websockets.exceptions.ConnectionClosed:
                # Issue #648: the hosted agent finished its turn and the server
                # closed the socket WITHOUT a trailing audio frame (a silent /
                # tool-only turn). Mirror the #646/PR647 reference pattern (and
                # the Gemini Live / Pipecat idiom): return an empty AudioChunk so
                # the base ``_drain_agent_response`` loop exits cleanly, instead
                # of letting ConnectionClosed propagate — the drain only catches
                # asyncio.TimeoutError, so an unhandled close would crash the turn.
                logger.debug(
                    "ElevenLabsAgentAdapter: socket closed during recv; "
                    "ending turn with empty chunk"
                )
                return AudioChunk(data=b"")
            # A received message (ping included) proves the socket is alive, so
            # re-arm the idle deadline. Placed BEFORE json.loads so ANY frame —
            # even a non-JSON/malformed one — counts as a liveness signal.
            saw_inbound_frame = True
            deadline = asyncio.get_running_loop().time() + timeout
            try:
                event = json.loads(raw) if isinstance(raw, str) else json.loads(raw.decode())
            except Exception:
                logger.debug("ElevenLabsAgentAdapter: non-JSON message, skipping")
                continue

            etype = event.get("type", "")
            logger.debug("ElevenLabsAgentAdapter: recv event %s", etype)

            if etype == "audio":
                audio_event = event.get("audio_event", {})
                b64 = audio_event.get("audio_base_64", "")
                pcm = base64.b64decode(b64)
                # Ensure even byte count (PCM16 invariant).
                if len(pcm) % 2 == 1:
                    pcm = pcm[:-1]
                # Agent turn audio has arrived → engage the post-response pause
                # so the pump stops streaming idle silence into the inter-turn
                # gap (mirror ``onAgentAudio`` setting ``awaitingUserTurn``).
                self._on_agent_audio_begin()
                return AudioChunk(data=pcm)

            elif etype == "ping":
                # Per EL docs, ping wire shape is
                #   {"type": "ping", "ping_event": {"event_id": <int>, "ping_ms": <int>}}
                # Pong must echo the event_id at the top level. The
                # fallback to top-level event_id covers any older shape.
                ping_event = event.get("ping_event") or {}
                event_id = ping_event.get("event_id")
                if event_id is None:
                    event_id = event.get("event_id")
                if event_id is None:
                    logger.debug("ElevenLabsAgentAdapter: ping with no event_id, skipping pong: %r", event)
                    continue
                pong = json.dumps({"type": "pong", "event_id": event_id})
                await self._ws.send(pong)

            elif etype == "user_transcript":
                self.last_user_transcript = event.get("user_transcription_event", {}).get("user_transcript")

            elif etype == "agent_response":
                self.last_agent_transcript = event.get("agent_response_event", {}).get("agent_response")

            elif etype == "agent_tool_response":
                # The agent invoked one of its own (server-side) tools. When
                # that tool is the ``end_call`` system tool, the agent has
                # deliberately hung up and EL closes the socket right after
                # this frame with a clean 1000 (issue #839).
                #
                # Wire shape (captured live):
                #   {"type": "agent_tool_response",
                #    "agent_tool_response": {"tool_name": "end_call",
                #      "tool_type": "system", "is_error": false,
                #      "is_blocked": false, "is_called": true, ...}}
                #
                # Recording it as a deliberate hangup — rather than letting the
                # ensuing close look like a dropped transport — is what lets a
                # leftover scripted turn conclude gracefully instead of failing
                # a run in which the agent behaved exactly as designed.
                tool = event.get("agent_tool_response", {}) or {}
                if (
                    tool.get("tool_name") in HANGUP_TOOL_NAMES
                    and tool.get("is_called")
                    and not tool.get("is_error")
                    and not tool.get("is_blocked")
                ):
                    logger.info(
                        "ElevenLabsAgentAdapter: agent invoked %r — treating the "
                        "upcoming close as a deliberate hangup",
                        tool.get("tool_name"),
                    )
                    self.agent_hung_up = True

            elif etype == "agent_response_correction":
                # EL signals a corrected agent reply (post server-side
                # barge-in detection). The corrected text replaces the
                # last_agent_transcript so consumers see what the agent
                # ACTUALLY said after our interrupt landed, not the
                # pre-correction draft.
                #
                # Wire shape:
                #   {"type": "agent_response_correction",
                #    "agent_response_correction_event": {
                #      "original_agent_response": "...",
                #      "corrected_agent_response": "..."}}
                correction = event.get("agent_response_correction_event", {}) or {}
                corrected = correction.get("corrected_agent_response")
                if corrected:
                    self.last_agent_transcript = corrected

            elif etype == "conversation_initiation_metadata":
                # EL reports the agent's actual configured audio formats
                # here. Our adapter capabilities advertise pcm16/24000,
                # matching the test agent we provision. If a caller
                # points the adapter at an agent configured differently,
                # this is where the mismatch becomes visible — warn so
                # the codec mismatch is logged rather than silently
                # garbling audio.
                #
                # Wire shape (per docs):
                #   {"type": "conversation_initiation_metadata",
                #    "conversation_initiation_metadata_event": {
                #      "conversation_id": "...",
                #      "agent_output_audio_format": "pcm_24000",
                #      "user_input_audio_format": "pcm_24000"}}
                meta = event.get("conversation_initiation_metadata_event", {}) or {}
                out_fmt = meta.get("agent_output_audio_format")
                in_fmt = meta.get("user_input_audio_format")
                if out_fmt and out_fmt != "pcm_24000":
                    logger.warning(
                        "ElevenLabsAgentAdapter: agent_output_audio_format=%r "
                        "differs from advertised pcm16/24000 capability; "
                        "audio may pitch-shift or fail to decode.",
                        out_fmt,
                    )
                if in_fmt and in_fmt != "pcm_24000":
                    logger.warning(
                        "ElevenLabsAgentAdapter: user_input_audio_format=%r "
                        "differs from advertised pcm16/24000 capability; "
                        "the agent may not understand audio we send.",
                        in_fmt,
                    )

            elif etype == "client_tool_call":
                # Issue #648: EL ConvAI emits ``client_tool_call`` when the agent
                # invokes a CLIENT-side tool. This adapter is a black-box test
                # harness and does NOT send ``client_tool_result`` back, so the
                # hosted agent will never produce spoken audio for this turn — it
                # is a tool-only / non-audio terminal turn. Mirror the #646/PR647
                # reference pattern: return an empty AudioChunk so the drain exits
                # cleanly instead of looping to the ``response_timeout`` deadline
                # and raising. The tool call is observable on the wire; we surface
                # the turn's completion, not its payload.
                logger.debug(
                    "ElevenLabsAgentAdapter: client_tool_call (tool-only turn); "
                    "ending turn with empty chunk"
                )
                return AudioChunk(data=b"")

            elif etype == "interruption":
                pass  # documented non-audio event, no action needed

            else:
                logger.debug("ElevenLabsAgentAdapter: unknown event type %r, skipping", etype)
