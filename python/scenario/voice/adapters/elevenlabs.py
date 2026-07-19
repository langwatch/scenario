"""
ElevenLabsAgentAdapter: connect to ElevenLabs Conversational AI via their WebSocket.

Source §5.4. Endpoint: wss://api.elevenlabs.io/v1/convai/conversation?agent_id=...
Exchanges PCM16 audio chunks.

Wire protocol:
- Send:
  - JSON ``{"user_audio_chunk": "<base64 PCM16>"}`` (legacy ``"silence"``
    turn-commit path, and the ``"text"`` fallback when a chunk carries no
    transcript)
  - JSON ``{"type": "user_message", "text": "<transcript>"}`` (default
    ``"text"`` turn-commit path) — the only documented client→server event
    that *deterministically* commits a user turn and forces an agent
    response without relying on mic-style server VAD. EL ConvAI exposes NO
    audio-flush / end-of-turn client event (verified against the official
    EL Python + JS SDKs), and ConvAI 2.0's end-of-turn is a hybrid VAD +
    deep-learning turn-detector (prosody, rhythm, micro-pauses), not a pure
    silence threshold — so a fixed zero-byte tail does NOT reliably commit
    a scripted, non-mic turn 2+ (issue #567). See ``send_audio`` and
    ``TurnCommitMode``.
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
from typing import Any, ClassVar, Deque, Literal, Optional

from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities


logger = logging.getLogger("scenario.voice.elevenlabs")

CONVAI_URL_TEMPLATE = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}"

#: Default zero-byte silence-tail length for the legacy ``"silence"`` turn-commit
#: path. 16000 zero bytes at pcm_24000 = ~333 ms of silence — the empirical
#: middle ground that historically let the *greeting → first user turn* exchange
#: work (see ``send_audio``).
#:
#: This tail is NOT reliable for scripted turn 2+ (issue #567): EL ConvAI 2.0's
#: end-of-turn is a hybrid VAD + deep-learning turn-detector, not a pure silence
#: threshold, so a fixed zero-byte blob does not deterministically trip it on a
#: non-mic stream. The default commit mode is therefore ``"text"``; the silence
#: tail survives as an opt-in for callers who want the pure server-VAD audio path.
SILENCE_TAIL_BYTES = 16000

#: How :meth:`ElevenLabsAgentAdapter.send_audio` signals end-of-turn to EL ConvAI.
#:
#: - ``"text"`` (default): send an explicit
#:   ``{"type": "user_message", "text": <transcript>}`` — the only documented
#:   client→server event that *deterministically* commits a turn and forces an
#:   agent response without relying on mic-style server VAD (issue #567).
#:   Requires a transcript on the outgoing :class:`AudioChunk` (the voice
#:   runtime threads the ``scenario.user("…")`` script text through as the chunk
#:   transcript via TTS); when absent, falls back to the silence tail.
#: - ``"silence"``: legacy behaviour — stream the audio then a fixed
#:   ``silence_tail_bytes`` zero-byte tail and hope server VAD fires. Kept for
#:   the pure-audio path and parity with the pre-#567 transport, but unreliable
#:   for scripted turn 2+.
TurnCommitMode = Literal["text", "silence"]

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
        turn_commit_mode: TurnCommitMode = "text",
        silence_tail_bytes: int = SILENCE_TAIL_BYTES,
    ) -> None:
        super().__init__()
        self.agent_id = agent_id
        self._api_key = api_key
        # Per-session overrides applied via conversation_initiation_client_data
        # at the start of every WS connect. Used by demos that need a
        # different prompt shape (e.g. verbose for interrupt demos) without
        # mutating the shared test agent's persistent config.
        self._system_prompt_override = system_prompt_override
        self._first_message_override = first_message_override
        # How a user turn is committed. Defaults to ``"text"`` (explicit
        # ``user_message`` commit) so scripted turn 2+ reliably re-engages an
        # agent response (issue #567). ``"silence"`` selects the legacy
        # pure-audio server-VAD path. See ``TurnCommitMode`` / ``send_audio``.
        if turn_commit_mode not in ("text", "silence"):
            raise ValueError(
                f'Unknown turn_commit_mode: {turn_commit_mode!r}. Expected "text" or "silence".'
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

        agent_override: dict[str, Any] = {}
        if self._system_prompt_override:
            agent_override["prompt"] = {"prompt": self._system_prompt_override}
        if self._first_message_override:
            agent_override["first_message"] = self._first_message_override

        init = {
            "type": "conversation_initiation_client_data",
            "conversation_config_override": {"agent": agent_override},
        }
        await self._ws.send(json.dumps(init))
        logger.debug(
            "ElevenLabsAgentAdapter: sent conversation_initiation_client_data with overrides=%s",
            list(agent_override.keys()) or "none",
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

        if self._outbound_frames:
            frame = self._outbound_frames.popleft()
        elif self.awaiting_user_turn:
            return
        else:
            frame = SILENCE_FRAME

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
            # An empty chunk carries no speech: don't disturb the pause, don't
            # enqueue a meaningless frame.
            return
        # A real user turn is starting → lift the post-response pause.
        self.awaiting_user_turn = False
        for offset in range(0, len(data), PUMP_FRAME_BYTES):
            slice_ = data[offset : offset + PUMP_FRAME_BYTES]
            if len(slice_) < PUMP_FRAME_BYTES:
                # Pad the final partial frame to a full 20 ms with trailing
                # zeros so the pump only ever feeds fixed-size frames.
                slice_ = slice_ + b"\x00" * (PUMP_FRAME_BYTES - len(slice_))
            self._outbound_frames.append(slice_)

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

        Two commit modes (see ``TurnCommitMode``):

        - ``"text"`` (default): when the chunk carries a transcript, send ONLY
          a ``{"type": "user_message", "text": <transcript>}`` turn — the only
          documented client event that deterministically forces an agent
          response without mic-style VAD. We do NOT also stream the raw audio
          here: sending ``user_audio_chunk`` and then ``user_message`` in the
          same turn races the server's audio ingestion against the text commit
          and was empirically flaky (the agent receive intermittently timed
          out). The text turn alone re-engages every time. Nothing observable
          is lost — the voice runtime records the user audio locally
          (independent of this send), and EL echoes the committed text back as
          a ``user_transcript`` event, so ``last_user_transcript`` still
          populates.
        - Fallback / ``"silence"``: stream the speech then a fixed
          ``silence_tail_bytes`` zero-byte tail and let server VAD try. Used
          when ``turn_commit_mode == "silence"``, or in ``"text"`` mode when
          the chunk carries no transcript to commit.

        Silence-tail size rationale (legacy path): 16000 zero bytes at
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
            # Deterministic commit: send ONLY the user_message text turn (no
            # racing user_audio_chunk). This is a single control frame, not
            # audio, so it does not compete with the pump's audio cadence. See
            # method docstring for the rationale.
            await self._send_user_message(transcript)
            return

        # Legacy / fallback path (turn_commit_mode == "silence", or "text" mode
        # with no transcript to commit): stream the speech then a closing
        # silence tail and let server VAD try.
        #
        # The pump is the SINGLE owner of WS audio writes: rather than writing
        # `chunk.data` and the 16KB silence tail DIRECTLY to `self._ws` (which
        # would race the always-running background pump — two concurrent writers
        # producing interleaved/oversized non-20ms `user_audio_chunk` frames),
        # we ENQUEUE the speech and the closing-silence tail as fixed 960-byte
        # pump frames. The pump drains them at the same 20ms cadence as every
        # other frame, so there is exactly one writer and a consistent frame
        # size on the wire. Returns promptly (continuous-mic model) — it does
        # not block until the queue drains.
        self.enqueue_speech(chunk.data)
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
        make this method wait **indefinitely**. There is deliberately **no
        total-duration ceiling** here — a legitimate 30s+ silent-but-pinging
        stretch must not abort the turn, which a cumulative budget would do.
        The caller's ``response_max_duration`` is checked *between*
        ``recv_audio`` calls and does **not** bound a single in-progress recv.
        (An absolute caller-side backstop for the wedged-agent case is tracked
        as a separate follow-up; it is intentionally not implemented here.)
        """
        import websockets  # for the ConnectionClosed terminal (issue #648)

        if self._ws is None:
            raise RuntimeError("ElevenLabsAgentAdapter: not connected")

        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise asyncio.TimeoutError("ElevenLabsAgentAdapter: recv_audio timed out")

            try:
                raw = await asyncio.wait_for(self._ws.recv(), timeout=remaining)
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
