"""
Platform demo — OpenAI Realtime as the agent under test.

What this demo proves:
    OpenAIRealtimeAgentAdapter(role=AgentRole.AGENT) establishes a Realtime API
    session where the *model itself* is the agent under test.  result.success is
    True after one user turn.

AC: specs/voice-agents.feature "Demo — OpenAI Realtime as the agent under test"
    Source §5.6, L800-813 and §4.1, L185-190.

How to run:
    cd python
    uv run examples/voice/openai_realtime_agent.py

Required env vars:
    OPENAI_API_KEY   — for OpenAIRealtimeAgentAdapter + JudgeAgent LLM

Note:
    The Realtime API transport is currently a Phase-2 stub
    (PendingTransportError on send_audio/recv_audio).  The demo will raise
    PendingTransportError once the transport ships. The e2e test is gated
    via a capability probe (requires_transport_ready) that auto-skips until
    the real transport lands.
"""

import asyncio
import os
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")
except ImportError:
    # python-dotenv is optional — examples still run with env already exported.
    pass

REQUIRED_ENV = ("OPENAI_API_KEY",)


def _check_env() -> None:
    missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
    if missing:
        sys.exit(f"Error: missing env vars: {missing}")


_check_env()

import scenario  # noqa: E402
from _recording_helper import save_demo_recording  # noqa: E402
from scenario.config.voice_models import OPENAI_REALTIME_MODEL  # noqa: E402
from scenario.types import AgentRole  # noqa: E402

scenario.configure(default_model="openai/gpt-5-mini")


async def main() -> scenario.ScenarioResult:
    result = await scenario.run(
        name="demo_openai_realtime_agent",
        description=(
            "OpenAI Realtime model plays the agent role. "
            "User says hello; model responds; judge evaluates."
        ),
        agents=[
            scenario.OpenAIRealtimeAgentAdapter(
                model=OPENAI_REALTIME_MODEL,
                voice="alloy",
                instructions="You are a helpful assistant. Keep responses brief.",
                role=AgentRole.AGENT,
            ),
            scenario.UserSimulatorAgent(voice="openai/nova"),
            scenario.JudgeAgent(
                criteria=[
                    "The agent responded naturally to the greeting",
                    # Claim from docstring: OpenAI Realtime model IS the agent under test.
                    # Reworded to be observable from messages: audio block + transcript present.
                    "The agent message contains an input_audio block alongside its transcript",
                    "The conversation is a coherent example of the OpenAI-Realtime-as-agent path",
                ]
            ),
        ],
        script=[
            scenario.user("Hello, can you help me?"),
            scenario.agent(),
            scenario.judge(),
        ],
        max_turns=4,
    )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
