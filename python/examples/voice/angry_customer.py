"""
Example 6.3 — Angry customer in noisy cafe.

What this demo proves:
    UserSimulatorAgent(voice="elevenlabs/rachel", persona=..., audio_effects=[...])
    delivers a difficult real-world test: an emotionally heightened caller with
    background cafe noise and phone codec quality degradation.
    The JudgeAgent evaluates empathy, noise-robustness, and resolution.

AC: specs/voice-agents.feature "Example 6.3 — angry customer in noisy cafe"
    Source §6.3, L931-967 and §8 emotional escalation.

How to run:
    cd python
    uv run examples/voice/angry_customer.py

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
            name="example_6_3_angry_customer",
            description=(
                "An angry customer calls from a noisy cafe about a wrong charge. "
                "The bot must handle the emotional tone and background noise, "
                "demonstrate empathy, and reach a resolution."
            ),
            agents=[
                scenario.PipecatAgentAdapter(
                    url=BOT_WS_URL,
                    audio_format="mulaw",
                    sample_rate=8000,
                ),
                scenario.UserSimulatorAgent(
                    # ElevenLabs voice with emotion support — openai/nova
                    # read angry text in a calm tone, defeating the demo.
                    # Sarah (EXAVITQu4vr4xnSDxMaL) is a clear, mature female
                    # voice in the default EL voice library; pair with the
                    # tonal markers in the persona below to render audible
                    # anger.
                    voice="elevenlabs/EXAVITQu4vr4xnSDxMaL",
                    persona=(
                        "Very angry customer who was charged incorrectly. "
                        "Speaking loudly and impatiently from a cafe. "
                        "Wants this fixed immediately. "
                        "IMPORTANT: format every reply with ElevenLabs tonal "
                        "markers inline so the synthesised voice sounds "
                        "audibly angry, not just textually. Use markers like "
                        "[shouting], [angry], [sigh], [exhales sharply], "
                        "[frustrated]. Example: '[shouting] You charged me "
                        "the wrong amount! [angry] Fix it NOW.' Do not strip "
                        "the markers — the TTS reads them as performance cues."
                    ),
                    audio_effects=[
                        scenario.effects.background_noise("cafe", 0.4),
                        scenario.effects.phone_quality(),
                    ],
                ),
                scenario.JudgeAgent(
                    criteria=[
                        "The agent demonstrated empathy toward the angry customer",
                        "The agent maintained composure despite background noise",
                        "The agent offered a concrete resolution or next step",
                        # Claim from docstring: emotional persona + cafe noise + phone codec.
                        "The user simulator delivered an emotionally heightened persona over audio (anger is audible in tone, not just in word choice — ElevenLabs tonal markers like [shouting] / [angry] drive the synthesis)",
                        "Background cafe noise and phone-codec quality were audibly present",
                        "The conversation is a coherent example of an angry-customer-in-a-noisy-cafe scenario",
                    ]
                ),
            ],
            # Voice convention: the bot greets first on connect (matches Twilio,
            # ElevenLabs ConvAI, OpenAI Realtime, etc.). The user's utterance is
            # turn 2, in response to the greeting — speaking over the greeting
            # would be a barge-in, not a fresh turn.
            script=[
                scenario.agent(),
                scenario.user(),
                scenario.proceed(turns=5),
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
