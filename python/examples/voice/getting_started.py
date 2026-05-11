"""
Getting Started — minimum runnable voice scenario.

What this demo proves:
    PipecatAgentAdapter (WebSocket + bundled stub bot) + UserSimulatorAgent +
    JudgeAgent form a working end-to-end voice test with only OPENAI_API_KEY
    set. The stub bot is auto-spawned — no extra terminal or cloud account
    required.

How to run:
    cd python
    uv run examples/voice/getting_started.py

    The bundled Pipecat stub bot is auto-spawned by ensure_pipecat_bot()
    and torn down on exit. If a bot is already listening on :8765 it is
    used as-is and left running.

Required env vars:
    OPENAI_API_KEY   — used by UserSimulatorAgent (TTS) and JudgeAgent (LLM)

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
    sys.exit("Error: OPENAI_API_KEY is required. Set it in python/.env or export it.")

import scenario  # noqa: E402
from _bot_lifecycle import ensure_pipecat_bot  # noqa: E402

scenario.configure(default_model="openai/gpt-4.1-mini")

BOT_WS_URL = os.environ.get("PIPECAT_BOT_URL", "ws://localhost:8765/stream")


async def main() -> scenario.ScenarioResult:
    """Run the getting-started voice scenario. Returns the ScenarioResult."""
    async with ensure_pipecat_bot():
        result = await scenario.run(
            name="voice_getting_started",
            description=(
                "A caller contacts a voice bot and asks a simple question. "
                "The bot replies helpfully. "
                "Judge: bot responded in a friendly, helpful manner."
            ),
            agents=[
                scenario.PipecatAgentAdapter(
                    url=BOT_WS_URL,
                    audio_format="mulaw",
                    sample_rate=8000,
                ),
                scenario.UserSimulatorAgent(voice="openai/nova"),
                scenario.JudgeAgent(
                    criteria=[
                        "The bot responded to the user in a friendly tone",
                        "The bot gave a helpful answer",
                        "The agent and user exchanged real audio turns over the WebSocket",
                    ]
                ),
            ],
            script=[
                scenario.user("Hello! Can you tell me what you can help me with?"),
                scenario.agent(),
                scenario.judge(),
            ],
        )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    return result


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(main()).success else 1)
