"""
Cross-cutting demo — Voice + text entrypoint parity.

What this demo proves:
    The same scenario.run() entrypoint handles BOTH a voice scenario and a
    text-only scenario with the same script and judge.  Both result.success
    are True.  No voice imports are loaded for the text-only path.

AC: specs/voice-agents.feature "Demo — same scenario.run() entrypoint for voice and text"
    Source §1 L9 — "no scenario.voice.run(), no separate paradigm."

How to run:
    cd python
    uv run examples/voice/voice_text_parity.py

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

from _bot_lifecycle import ensure_pipecat_bot  # noqa: E402
from _recording_helper import save_demo_recording  # noqa: E402

REQUIRED_ENV = ("OPENAI_API_KEY",)


def _check_env() -> None:
    missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
    if missing:
        sys.exit(f"Error: missing env vars: {missing}")


_check_env()

import scenario  # noqa: E402

scenario.configure(default_model="openai/gpt-5-mini")

BOT_WS_URL = os.environ.get("PIPECAT_BOT_URL", "ws://localhost:8765/stream")

SHARED_CRITERIA = [
    "The agent responded helpfully to the greeting",
    # Claim from docstring: same scenario.run() entrypoint handles voice AND text scenarios.
    "The exchange completed successfully through scenario.run() without a separate paradigm",
    "The conversation is a coherent example of the voice/text-entrypoint-parity contract",
]

SHARED_SCRIPT = [
    scenario.user("Hello, can you help me?"),
    scenario.agent(),
    scenario.judge(),
]


class _SimpleTextAgent(scenario.AgentAdapter):
    """Minimal text-only agent that echoes a polite reply."""

    async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
        return "Hi there! I'm happy to help. What do you need?"


async def run_text_scenario() -> scenario.ScenarioResult:
    """Text-only scenario — no voice adapters, no TTS, no audio imports."""
    return await scenario.run(
        name="parity_text",
        description="Text-only control: same script and judge, no voice.",
        agents=[
            _SimpleTextAgent(),
            scenario.UserSimulatorAgent(),  # no voice= → text only
            scenario.JudgeAgent(criteria=SHARED_CRITERIA),
        ],
        script=SHARED_SCRIPT,
        max_turns=4,
    )


async def run_voice_scenario() -> scenario.ScenarioResult:
    """Voice scenario — same entrypoint, same script, voice adapter swapped in."""
    return await scenario.run(
        name="parity_voice",
        description="Voice path: PipecatAgentAdapter + voice UserSimulator, same judge.",
        agents=[
            scenario.PipecatAgentAdapter(
                url=BOT_WS_URL,
                audio_format="mulaw",
                sample_rate=8000,
            ),
            scenario.UserSimulatorAgent(voice="openai/nova"),
            scenario.JudgeAgent(criteria=SHARED_CRITERIA),
        ],
        script=SHARED_SCRIPT,
        max_turns=4,
    )


async def main() -> tuple[scenario.ScenarioResult, scenario.ScenarioResult]:
    print("Running text scenario…")
    text_result = await run_text_scenario()
    print(f"text  success={text_result.success}  audio={text_result.audio}")

    print("\nRunning voice scenario…")
    async with ensure_pipecat_bot():
        voice_result = await run_voice_scenario()
    print(f"voice success={voice_result.success}  audio_segments={len(voice_result.audio.segments) if voice_result.audio else 0}")
    save_demo_recording(getattr(voice_result, "audio", None))
    return text_result, voice_result


if __name__ == "__main__":
    text_r, voice_r = asyncio.run(main())
    if text_r.success and voice_r.success:
        print("\nBoth scenarios passed.")
    else:
        print(f"\nFailed — text:{text_r.success} voice:{voice_r.success}")
        sys.exit(1)
