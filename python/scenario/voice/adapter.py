"""
VoiceAgentAdapter — base class for voice-capable agents.

Extends AgentAdapter (text-based) with audio send/receive primitives and a
capability matrix. Concrete subclasses live under
``scenario.voice.adapters`` (PipecatAgent, LiveKitAgent, etc.).

The scenario executor calls ``connect()`` automatically at scenario start and
``disconnect()`` at end — users do not manage lifecycle.
"""

from __future__ import annotations

from abc import abstractmethod
from typing import ClassVar

from ..agent_adapter import AgentAdapter
from ..types import AgentInput, AgentReturnTypes, AgentRole
from .audio_chunk import AudioChunk
from .capabilities import AdapterCapabilities


class VoiceAgentAdapter(AgentAdapter):
    """
    Abstract base for voice agents that exchange audio with the agent under test.

    Subclasses implement ``connect``, ``disconnect``, ``send_audio``, and
    ``recv_audio``. The default ``call`` implementation threads audio extracted
    from the last incoming message through the transport and wraps the response
    back into an assistant message.

    Attributes:
        capabilities: Declaration of what the adapter can and cannot do. Each
            concrete subclass must set this as a class attribute.
        response_timeout: Seconds to wait for agent audio after sending user
            audio. Defaults to 30 seconds.
    """

    role: ClassVar[AgentRole] = AgentRole.AGENT
    capabilities: ClassVar[AdapterCapabilities] = AdapterCapabilities()
    response_timeout: float = 30.0

    @abstractmethod
    async def connect(self) -> None:
        """Open the transport and prepare to exchange audio."""

    @abstractmethod
    async def disconnect(self) -> None:
        """Close the transport and release resources."""

    @abstractmethod
    async def send_audio(self, chunk: AudioChunk) -> None:
        """Transmit an AudioChunk to the agent under test."""

    @abstractmethod
    async def recv_audio(self, timeout: float) -> AudioChunk:
        """Receive the next AudioChunk from the agent."""

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        """
        Default implementation: extract audio from the latest user message,
        send it, wait for a response, return as an assistant audio message.

        Subclasses may override this for specialised flows but will usually
        inherit it.
        """
        from .messages import create_audio_message, extract_audio

        incoming = extract_audio(input.new_messages[-1]) if input.new_messages else None
        if incoming is not None:
            await self.send_audio(incoming)
        response = await self.recv_audio(timeout=self.response_timeout)
        return create_audio_message(response, role="assistant")
