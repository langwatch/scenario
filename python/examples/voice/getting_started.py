"""
Getting Started — Scenario voice agents (OpenAI Realtime path).

What this proves:
    Scenario can drive a voice conversation end-to-end against an
    OpenAI Realtime agent. OpenAIRealtimeAgentAdapter is BOTH the
    scenario.run() adapter AND the agent under test. Only requires
    OPENAI_API_KEY.

Real users:
    Replace the OpenAIRealtimeAgentAdapter with the adapter that
    matches your stack (PipecatAgentAdapter for a Pipecat bot,
    TwilioAgentAdapter for a Twilio number, ElevenLabsAgentAdapter
    for a hosted ElevenLabs agent). See docs/voice/choosing-an-adapter.md.

How to run:
    cd python
    uv run examples/voice/getting_started.py

Required env vars:
    OPENAI_API_KEY   — for OpenAIRealtimeAgentAdapter + JudgeAgent LLM

See also:
    docs/docs/pages/voice/getting-started.mdx — rendered docs page
    specs/voice-agents.feature               — full behavioral contract
"""

import asyncio
import os
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")
except ImportError:
    # python-dotenv is optional — OPENAI_API_KEY may already be in the shell.
    pass

if not os.environ.get("OPENAI_API_KEY"):
    sys.exit("Error: OPENAI_API_KEY required.")

import scenario  # noqa: E402
from scenario.config.voice_models import OPENAI_REALTIME_MODEL  # noqa: E402
from scenario.types import AgentRole  # noqa: E402

scenario.configure(default_model="openai/gpt-4.1-mini")


async def main() -> scenario.ScenarioResult:
    """Run the getting-started voice scenario. Returns the ScenarioResult."""
    result = await scenario.run(
        name="voice_getting_started",
        description=(
            "A caller asks the agent a simple question. "
            "The agent responds helpfully."
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
                    "The agent responded helpfully to the user's question",
                    "The agent and user exchanged real audio turns",
                ]
            ),
        ],
        script=[
            scenario.user("Hi, can you help me?"),
            scenario.agent(),
            scenario.judge(),
        ],
    )
    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    return result


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(main()).success else 1)
