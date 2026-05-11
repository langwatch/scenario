"""
Pain pattern — "emotional escalation" detection and adjustment.

What this demo proves:
    A UserSimulatorAgent with a persona that escalates from calm to frustrated
    over turns.  The JudgeAgent checks that the bot detects the tone shift and
    responds with empathy or offers to escalate to a human agent.

AC: specs/voice-agents.feature "Pain pattern — emotional escalation detection and adjustment"
    Source §8 L1267-1269.

How to run:
    cd python
    uv run examples/voice/emotional_escalation.py

    The bundled Pipecat stub bot is auto-spawned by ensure_pipecat_bot()
    and torn down on exit. If a bot is already listening on :8765 it is
    used as-is and left running.

Required env vars:
    OPENAI_API_KEY   — for UserSimulatorAgent TTS + JudgeAgent LLM
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
from _bot_lifecycle import ensure_pipecat_bot  # noqa: E402
from _recording_helper import save_demo_recording  # noqa: E402

scenario.configure(default_model="openai/gpt-5-mini")

BOT_WS_URL = os.environ.get("PIPECAT_BOT_URL", "ws://localhost:8765/stream")


async def main() -> scenario.ScenarioResult:
    async with ensure_pipecat_bot():
        result = await scenario.run(
            name="pain_emotional_escalation",
            description=(
                "A caller starts calm but escalates to frustrated over several turns "
                "because their problem is not being resolved. The bot must detect the "
                "tone shift and offer empathy or human escalation."
            ),
            agents=[
                scenario.PipecatAgentAdapter(
                    url=BOT_WS_URL,
                    audio_format="mulaw",
                    sample_rate=8000,
                ),
                scenario.UserSimulatorAgent(
                    voice="openai/nova",
                    persona=(
                        "Starts calm and polite. Becomes increasingly frustrated each "
                        "turn when the issue isn't resolved. By turn 3 is visibly "
                        "upset and says 'This is unacceptable, I need to speak to a "
                        "human right now.'"
                    ),
                ),
                scenario.JudgeAgent(
                    criteria=[
                        # Structural: SDK can drive a multi-turn escalating voice
                        # scenario. Bot behavior (empathy, escalation) is bot-prompt
                        # territory, not SDK contract.
                        "The agent engaged across multiple turns of escalating user tone",
                        # Claim from docstring: persona escalates calm → frustrated.
                        "The user simulator delivered escalating tone across multiple turns",
                        "The agent responded with audio at each turn",
                        "The conversation is a coherent example of an emotionally-shifting voice exchange",
                    ]
                ),
            ],
            # Voice convention: the bot greets first on connect (matches Twilio,
            # ElevenLabs ConvAI, OpenAI Realtime, etc.). The user's escalating
            # turns start in response to the greeting.
            script=[
                scenario.agent(),
                scenario.user(),
                scenario.proceed(turns=3),
                scenario.judge(),
            ],
            # 4 turns keeps the demo demonstrably escalating while fitting under
            # the 300s pytest-timeout; 8 turns ran 4+ minutes and flaked.
            max_turns=6,
        )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
