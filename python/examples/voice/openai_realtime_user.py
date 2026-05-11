"""
Platform demo — OpenAI Realtime as the user simulator.

What this demo proves:
    OpenAIRealtimeAgentAdapter(role=AgentRole.USER) drives the user side of the
    conversation with natural prosody — text TTS is bypassed and the Realtime
    model handles user audio synthesis directly.

AC: specs/voice-agents.feature "Demo — OpenAI Realtime as the user simulator"
    Source §7.2, L1164-1171.

How to run:
    cd python
    uv run examples/voice/openai_realtime_user.py

    The bundled Pipecat stub bot (the AUT side) is auto-spawned by
    ensure_pipecat_bot() and torn down on exit. If a bot is already
    listening on :8765 it is used as-is and left running.

Required env vars:
    OPENAI_API_KEY   — for OpenAIRealtimeAgentAdapter + JudgeAgent LLM

Status — phase-2 gap:
    Each adapter owns its own transport (OpenAI Realtime owns a WS to OpenAI;
    PipecatAgentAdapter owns a WS to the bot). There is no bridge yet that
    pipes the user-side adapter's emitted audio into the agent-side adapter's
    input. As a result, the Pipecat AUT hears silence and times out in
    recv_audio. The demo guards against that here so reviewers see a clear
    "skipped: not yet implemented" instead of an opaque Pipecat traceback.
    When cross-adapter audio bridging lands, delete the guard and remove
    this section.
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

# Phase-2 gap: cross-adapter audio bridging not yet implemented.
# See module docstring "Status — phase-2 gap." Skip cleanly so reviewers
# do not see an opaque Pipecat recv_audio timeout traceback.
print(
    "Skipped: OpenAI Realtime ↔ Pipecat audio bridging not yet implemented. "
    "When the bridge ships this guard is removed and the demo runs end-to-end."
)
sys.exit(0)


import scenario  # noqa: E402
from _bot_lifecycle import ensure_pipecat_bot  # noqa: E402
from _recording_helper import save_demo_recording  # noqa: E402
from scenario.config.voice_models import OPENAI_REALTIME_MODEL  # noqa: E402
from scenario.types import AgentRole  # noqa: E402

scenario.configure(default_model="openai/gpt-5-mini")

BOT_WS_URL = os.environ.get("PIPECAT_BOT_URL", "ws://localhost:8765/stream")


async def main() -> scenario.ScenarioResult:
    async with ensure_pipecat_bot():
        result = await scenario.run(
            name="demo_openai_realtime_user",
            description=(
                "OpenAI Realtime model plays the USER role — a confused elderly customer. "
                "Scripted user('...') lines are delivered with natural prosody. "
                "The Pipecat bot plays the agent role."
            ),
            agents=[
                scenario.PipecatAgentAdapter(
                    url=BOT_WS_URL,
                    audio_format="mulaw",
                    sample_rate=8000,
                ),
                scenario.OpenAIRealtimeAgentAdapter(
                    model=OPENAI_REALTIME_MODEL,
                    voice="nova",
                    instructions=(
                        "You are simulating a confused elderly customer who is not "
                        "familiar with technology. Speak slowly and hesitantly."
                    ),
                    role=AgentRole.USER,
                ),
                scenario.JudgeAgent(
                    criteria=[
                        "The user simulator delivered lines with natural voice prosody",
                        "The agent responded helpfully to the confused elderly persona",
                    ]
                ),
            ],
            script=[
                scenario.user("Hello? Is this... the help desk?"),
                scenario.agent(),
                scenario.user("I don't understand what you mean by 'account number'"),
                scenario.agent(),
                scenario.judge(),
            ],
            max_turns=6,
        )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
