"""
OpenAIRealtimeAgentAdapter: direct-to-model adapter — the model IS the agent.

Source §5.6 + §7.2 L1164-1171. Unlike the other adapters which wrap a user's
running agent, this one IS the agent under test (or, when
``role=AgentRole.USER``, the voice-enabled user simulator).
"""

from __future__ import annotations

from typing import Any, ClassVar, List, Optional

from ...types import AgentRole
from ..adapter import VoiceAgentAdapter
from ..audio_chunk import AudioChunk
from ..capabilities import AdapterCapabilities


class OpenAIRealtimeAgentAdapter(VoiceAgentAdapter):
    """
    Exercise OpenAI's Realtime API as either the agent under test
    (role=AGENT, default) or as the voice-enabled user simulator
    (role=USER, per §7.2 L1164-1171).

    When role=USER, scripted ``user("text")`` steps route text through the
    realtime session's text-input channel rather than triggering TTS.
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
        model: str = "gpt-4o-realtime-preview",
        voice: str = "alloy",
        instructions: str = "",
        tools: Optional[List[Any]] = None,
        *,
        role: AgentRole = AgentRole.AGENT,
    ):
        self.model = model
        self.voice = voice
        self.instructions = instructions
        self.tools = tools or []
        self.role = role  # type: ignore[misc]
        self._session: Optional[object] = None

    async def connect(self) -> None:
        self._session = object()

    async def disconnect(self) -> None:
        self._session = None

    async def send_audio(self, chunk: AudioChunk) -> None:
        from ._stub import PendingTransportError
        if self._session is None:
            raise RuntimeError("OpenAIRealtimeAgentAdapter: not connected")
        raise PendingTransportError("OpenAIRealtimeAgentAdapter")

    async def recv_audio(self, timeout: float) -> AudioChunk:
        from ._stub import PendingTransportError
        if self._session is None:
            raise RuntimeError("OpenAIRealtimeAgentAdapter: not connected")
        raise PendingTransportError("OpenAIRealtimeAgentAdapter")

    async def send_text(self, text: str) -> None:
        """
        Inject text into the realtime session.

        Used when this adapter is the user simulator (role=USER): scripted
        ``user("text")`` steps route through here instead of spawning TTS.

        NOTE: per §7.2, OpenAI Realtime cannot populate assistant audio
        messages retroactively; the downstream transcript reflects what the
        model actually emitted, not what was scripted.
        """
        if self._session is None:
            raise RuntimeError("OpenAIRealtimeAgentAdapter: not connected")
