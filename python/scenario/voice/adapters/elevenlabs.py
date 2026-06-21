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
from typing import Any, ClassVar, Literal, Optional

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

    async def disconnect(self) -> None:
        """Close the WebSocket if open."""
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

        if self._turn_commit_mode == "text" and transcript:
            # Deterministic commit: send ONLY the user_message text turn (no
            # racing user_audio_chunk). See method docstring for the rationale.
            await self._send_user_message(transcript)
            return

        # Legacy / fallback path: stream the speech then a silence tail and let
        # server VAD try. Used when turn_commit_mode is "silence", or in "text"
        # mode when the chunk carries no transcript to commit.
        b64 = base64.b64encode(chunk.data).decode()
        await self._ws.send(json.dumps({"user_audio_chunk": b64}))

        await self._send_silence_tail()

    async def _send_user_message(self, text: str) -> None:
        """Explicit turn-commit: tell EL the user is done and force an agent
        response without relying on mic-style server VAD (issue #567). Wire
        shape matches the official SDK's ``user_message`` event.
        """
        await self._ws.send(json.dumps({"type": "user_message", "text": text}))

    async def _send_silence_tail(self) -> None:
        """Legacy end-of-turn nudge: a fixed zero-byte tail to coax server VAD."""
        silence = b"\x00" * self._silence_tail_bytes
        silence_b64 = base64.b64encode(silence).decode()
        await self._ws.send(json.dumps({"user_audio_chunk": silence_b64}))

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
