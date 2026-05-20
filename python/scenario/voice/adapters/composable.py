"""
Composable and provider-branded voice agents.

Two classes live here:

``ComposableVoiceAgent``
    Assembles any STTProvider + litellm LLM + TTS voice string into a
    VoiceAgentAdapter. The STT→LLM→TTS loop runs locally, giving full
    observability into each seam.

``ElevenLabsVoiceAgent``
    Branded preset: wires ElevenLabsSTTProvider and an ElevenLabs TTS voice
    by default, accepts per-piece overrides.

Both expose ``last_user_transcript`` and ``last_llm_response`` for scenario
harness assertions.
"""

from __future__ import annotations

from typing import ClassVar, List, Optional

from ...config.voice_models import COMPOSABLE_VOICE_LLM_MODEL
from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities
from ..stt import ElevenLabsSTTProvider, STTProvider


class ComposableVoiceAgent(VoiceAgentAdapter):
    """
    Locally-executed STT → LLM → TTS voice agent.

    ``stt`` transcribes incoming user audio, the result is fed to ``llm``
    (a litellm model string) along with conversation history, and the response
    is synthesised via the ``tts`` voice string using the existing
    ``scenario.voice.synthesize`` router.

    Each seam is independently swappable — change any one without touching the
    other two. Intermediate results are surfaced on instance attributes so the
    scenario harness can assert on them.

    Attributes:
        last_user_transcript: Transcript of the most-recent user audio turn.
        last_llm_response: Text produced by the LLM for the most-recent turn.
    """

    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities(
        streaming_transcripts=True,
        native_vad=False,
        dtmf=False,
        input_formats=["pcm16/24000"],
        output_formats=["pcm16/24000"],
    )

    DEFAULT_SYSTEM_PROMPT = (
        "You are a helpful voice assistant. Respond naturally and conversationally "
        "as this is an audio conversation — be concise, friendly, and clear."
    )

    def __init__(
        self,
        stt: STTProvider,
        llm: str,
        tts: str,
        *,
        system_prompt: Optional[str] = None,
    ) -> None:
        """
        Args:
            stt: STTProvider implementation for the user's audio.
            llm: litellm-style model identifier, e.g. ``COMPOSABLE_VOICE_LLM_MODEL``.
            tts: TTS voice string in ``"provider/voice"`` format,
                 e.g. ``"openai/nova"`` or ``"elevenlabs/rachel"``.
            system_prompt: Optional system prompt seeded at turn zero so the
                LLM has guidance before the first user message. Defaults to a
                generic helpful-assistant prompt.
        """
        super().__init__()
        self.stt = stt
        self.llm = llm
        self.tts = tts

        self.last_user_transcript: Optional[str] = None
        self.last_llm_response: Optional[str] = None

        # Seed history with a system prompt so the first recv_audio call (which
        # can happen before any user audio when the agent speaks first) doesn't
        # send an empty messages array to the LLM.
        self._history: List[dict] = [
            {"role": "system", "content": system_prompt or self.DEFAULT_SYSTEM_PROMPT}
        ]
        # Turn-output guard. ``recv_audio`` synthesises ONE chunk per
        # user turn. The default ``call()`` drains by re-calling
        # ``recv_audio`` until tail-silence — on this adapter that would
        # kick a second LLM call, cancelled later by timeout (wasted
        # credits + latency). The guard makes subsequent ``recv_audio``
        # calls in the same turn return an empty chunk, which the drain
        # loop interprets as end-of-stream.
        #
        # Reset boundary: ``send_audio`` (new user audio → new turn).
        # Set boundary: end of ``recv_audio`` (LLM+TTS completed).
        self._turn_output_emitted: bool = False

    def __repr__(self) -> str:
        return f"ComposableVoiceAgent(llm={self.llm!r}, tts={self.tts!r})"

    # ------------------------------------------------------------------ lifecycle

    async def connect(self) -> None:
        """No-op — no external transport to open."""

    async def disconnect(self) -> None:
        """No-op — nothing to tear down."""

    # ------------------------------------------------------------------ I/O

    async def send_audio(self, chunk: AudioChunk) -> None:
        """Transcribe the chunk via STT and store for the next recv_audio call."""
        transcript = await self.stt.transcribe(chunk)
        self.last_user_transcript = transcript
        self._history.append({"role": "user", "content": transcript})
        # New user turn → next recv_audio is allowed to synthesise.
        self._turn_output_emitted = False

    async def recv_audio(self, timeout: float) -> AudioChunk:
        """
        Run the LLM on the current history, synthesise the response via TTS,
        and return the resulting AudioChunk.

        ``timeout`` is honoured for the combined LLM+TTS call via
        ``asyncio.wait_for``. Subsequent calls in the same turn (the
        default ``call()`` drains until tail-silence) return an empty
        chunk so the drain loop exits without billing a second LLM
        round-trip — see ``_turn_output_emitted`` for the guard contract.
        """
        if self._turn_output_emitted:
            return AudioChunk(data=b"")

        import asyncio

        async def _run() -> AudioChunk:
            import litellm  # type: ignore
            from litellm.types.utils import Choices, ModelResponse
            from typing import cast as _cast

            from ..tts import synthesize

            completion = await litellm.acompletion(
                model=self.llm,
                messages=self._history,
            )
            # Non-streaming acompletion returns ModelResponse with Choices;
            # cast satisfies pyright without runtime isinstance overhead.
            completion = _cast(ModelResponse, completion)
            choice = _cast(Choices, completion.choices[0])
            response_text: str = choice.message.content or ""
            self.last_llm_response = response_text
            self._history.append({"role": "assistant", "content": response_text})

            return await synthesize(response_text, self.tts)

        chunk = await asyncio.wait_for(_run(), timeout=timeout)
        self._turn_output_emitted = True
        return chunk


class ElevenLabsVoiceAgent(ComposableVoiceAgent):
    """
    Composable voice agent with ElevenLabs-opinionated defaults.

    Not to be confused with :class:`ElevenLabsAgentAdapter` (in
    ``scenario.voice.adapters.elevenlabs``) — that one talks to ElevenLabs'
    **hosted** Conversational AI endpoint where EL runs the full
    STT→LLM→TTS loop. This class is local: you compose ``ElevenLabsSTTProvider``
    + any LLM + ElevenLabs TTS yourself, keeping full control over prompts,
    model choice, and tool calls.

    Instantiate with just an ``api_key`` to get an ElevenLabs STT +
    LLM (default ``COMPOSABLE_VOICE_LLM_MODEL``) + ``elevenlabs/rachel`` TTS stack. Each piece
    can be overridden independently without changing the others.

    Example::

        # Defaults — all ElevenLabs STT, GPT-4o-mini, ElevenLabs TTS
        agent = ElevenLabsVoiceAgent(api_key="sk-...")

        # Override just the LLM
        agent = ElevenLabsVoiceAgent(api_key="sk-...", llm="openai/gpt-4o")

        # Bring your own STT
        agent = ElevenLabsVoiceAgent(api_key="sk-...", stt=MyCustomSTT())
    """

    def __init__(
        self,
        api_key: str,
        *,
        llm: str = COMPOSABLE_VOICE_LLM_MODEL,
        voice: Optional[str] = None,
        stt: Optional[STTProvider] = None,
        system_prompt: Optional[str] = None,
    ) -> None:
        """
        Args:
            api_key: ElevenLabs API key. Redacted in ``__repr__``.
            llm: litellm-style model identifier. Defaults to
                ``COMPOSABLE_VOICE_LLM_MODEL``.
            voice: TTS voice string in ``"elevenlabs/<voice_id>"`` format.
                Defaults to the ``ELEVENLABS_VOICE_ID`` environment variable
                when set, otherwise falls back to "Sarah"
                (``"elevenlabs/EXAVITQu4vr4xnSDxMaL"``) — premade and
                accessible on the ElevenLabs free tier as of 2026-05.
                Other premade voices (e.g. "Rachel"
                ``21m00Tcm4TlvDq8ikWAM``) returned 402 paid_plan_required
                from the EL TTS API; gating differs per voice.  Set
                ``ELEVENLABS_VOICE_ID`` to override.
            stt: STTProvider override. Defaults to
                ``ElevenLabsSTTProvider(api_key=api_key)``.
            system_prompt: Optional system prompt. Defaults to
                ``ComposableVoiceAgent.DEFAULT_SYSTEM_PROMPT``.
        """
        import os

        if voice is None:
            env_voice_id = os.environ.get("ELEVENLABS_VOICE_ID")
            voice = (
                f"elevenlabs/{env_voice_id}"
                if env_voice_id
                else "elevenlabs/EXAVITQu4vr4xnSDxMaL"  # "Sarah" — free-tier premade
            )
        resolved_stt = stt if stt is not None else ElevenLabsSTTProvider(api_key=api_key)
        super().__init__(stt=resolved_stt, llm=llm, tts=voice, system_prompt=system_prompt)
        self._api_key = api_key
        self.voice = voice

    def __repr__(self) -> str:  # redact credentials
        return (
            f"ElevenLabsVoiceAgent("
            f"api_key='***', llm={self.llm!r}, voice={self.voice!r})"
        )
