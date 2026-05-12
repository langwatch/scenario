"""
Platform demo — ElevenLabs hosted Conversational AI.

What this demo proves:
    ElevenLabsAgentAdapter connects to
    wss://api.elevenlabs.io/v1/convai/conversation?agent_id=<ID>,
    exchanges audio turns via the real WebSocket transport, and completes a
    single-turn scenario with result.success == True.

AC: specs/voice-agents.feature "Demo — ElevenLabs hosted Conversational AI"
    Source §5.4, L760-776.

How to run:
    # 1. Provision the ElevenLabs test agent (creates ELEVENLABS_AGENT_ID in .env):
    make voice-elevenlabs-provision

    # 2. Run this demo:
    cd python
    uv run examples/voice/elevenlabs_hosted.py

Required env vars:
    OPENAI_API_KEY       — for JudgeAgent LLM
    ELEVENLABS_API_KEY   — ElevenLabs platform key
    ELEVENLABS_AGENT_ID  — ID of your hosted Conversational AI agent
                           (set by `make voice-elevenlabs-provision`)
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

REQUIRED_ENV = ("OPENAI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID")


def _check_env() -> None:
    missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
    if missing:
        sys.exit(f"Error: missing env vars: {missing}")


_check_env()

import scenario  # noqa: E402
from _recording_helper import save_demo_recording  # noqa: E402

scenario.configure(default_model="openai/gpt-5-mini")


async def main() -> scenario.ScenarioResult:
    result = await scenario.run(
        name="demo_elevenlabs_hosted",
        description=(
            "Two-turn happy path against a live ElevenLabs Conversational AI "
            "agent. Greeting plays on connect (real-voice convention), user "
            "asks a question, agent responds, user asks a follow-up that "
            "references the first turn, agent answers in context; judge "
            "evaluates naturalness AND continuity."
        ),
        agents=[
            scenario.ElevenLabsAgentAdapter(
                agent_id=os.environ["ELEVENLABS_AGENT_ID"],
                api_key=os.environ["ELEVENLABS_API_KEY"],
            ),
            scenario.UserSimulatorAgent(voice="openai/nova"),
            scenario.JudgeAgent(
                criteria=[
                    "The agent's initial greeting (sent on connect) is natural and conversational",
                    "The agent and user exchanged real audio turns via the live WebSocket",
                    "The agent's reply to the follow-up addresses it coherently in context of the first user turn",
                    "The conversation is a coherent example of the hosted ElevenLabs Conversational AI path",
                ]
            ),
        ],
        script=[
            # Real voice convention: EL sends first_message on connect.
            # Lead with agent() so the greeting drains before user audio
            # hits the wire.
            scenario.agent(),
            scenario.user("Hello, I have a question about my account."),
            scenario.agent(),
            scenario.user("What information do you need from me to look it up?"),
            scenario.agent(),
            scenario.judge(),
        ],
        max_turns=8,
    )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
