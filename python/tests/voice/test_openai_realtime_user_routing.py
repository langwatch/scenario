"""
Unit test for OpenAIRealtimeAgentAdapter(role=USER) text-routing (§7.2 L1164-1171).

Scripted ``user("text")`` steps must route through the realtime session's
text-input channel (send_text) rather than triggering TTS on a
UserSimulatorAgent.
"""

import pytest

import scenario
from scenario.voice import AdapterCapabilities, AudioChunk, VoiceAgentAdapter
from scenario.voice.adapters.openai_realtime import OpenAIRealtimeAgentAdapter


class _QuietAgent(VoiceAgentAdapter):
    capabilities = AdapterCapabilities()

    async def connect(self):
        pass
    async def disconnect(self):
        pass
    async def send_audio(self, chunk):
        pass
    async def recv_audio(self, timeout):
        return AudioChunk(data=b"\x00\x00" * 2400, transcript="ok")


@pytest.mark.asyncio
async def test_scripted_user_text_routes_to_realtime_send_text(monkeypatch):
    captured: list[str] = []

    realtime_user = OpenAIRealtimeAgentAdapter(role=scenario.AgentRole.USER)

    async def _fake_send_text(text: str) -> None:
        captured.append(text)

    # Stub network-touching methods so this stays a unit test (no real
    # OpenAI Realtime WebSocket handshake — CI has no OPENAI_API_KEY).
    async def _noop(*_a, **_kw) -> None:
        return None

    async def _fake_recv(_timeout: float) -> AudioChunk:
        return AudioChunk(data=b"\x00\x00" * 2400, transcript="ok")

    monkeypatch.setattr(realtime_user, "connect", _noop)
    monkeypatch.setattr(realtime_user, "disconnect", _noop)
    monkeypatch.setattr(realtime_user, "send_audio", _noop)
    monkeypatch.setattr(realtime_user, "recv_audio", _fake_recv)
    monkeypatch.setattr(realtime_user, "send_text", _fake_send_text)

    result = await scenario.run(
        name="realtime-user-routing",
        description="user('text') must call send_text, not TTS",
        agents=[_QuietAgent(), realtime_user],
        script=[
            scenario.user("hello from the test"),
            scenario.agent(),
            scenario.succeed("done"),
        ],
    )
    assert result.success
    assert captured == ["hello from the test"]
