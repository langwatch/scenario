"""
Platform demo — Gemini Live interruption (server-side VAD barge-in).

What this demo proves:
    GeminiLiveAgentAdapter advertises ``capabilities.interruption=False`` because
    the Gemini Live protocol exposes no client-initiated cancel signal.
    Interruption on this transport relies on the Gemini server's voice-activity
    detector: when our user audio arrives mid-agent-utterance, Gemini's VAD
    detects barge-in and the agent stops speaking on its end.

    The executor's _fire_user_interrupt:
      - awaits the agent's first audio chunk (so we don't barge into silence)
      - skips the native interrupt branch (capability gate False)
      - pushes the new user audio onto the wire
      - records ``user_interrupt {outcome: "fired", native: false}`` in the
        timeline; manifest.json gets the event + ``transcript_truncated`` on
        the agent segment that was alive when the interrupt fired.

AC: specs/voice-agents.feature "Demo — Gemini Live interruption (server VAD barge-in)"

How to run:
    cd python
    uv run examples/voice/gemini_live_interruption.py

Required env vars:
    GEMINI_API_KEY      — Gemini Live agent + judge LLM
    ELEVENLABS_API_KEY  — UserSimulatorAgent TTS voice (no OpenAI dep)
"""

import asyncio
import os
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")
except ImportError:
    pass

REQUIRED_ENV = ("GEMINI_API_KEY", "ELEVENLABS_API_KEY")


def _check_env() -> None:
    missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
    if missing:
        sys.exit(f"Error: missing env vars: {missing}")


_check_env()

import scenario  # noqa: E402
from _recording_helper import save_demo_recording  # noqa: E402
from scenario.config.voice_models import GEMINI_LIVE_MODEL  # noqa: E402

# Judge runs on Gemini — no OpenAI dependency in this demo.
scenario.configure(default_model="gemini/gemini-2.5-flash")


async def main() -> scenario.ScenarioResult:
    result = await scenario.run(
        name="demo_gemini_live_interruption",
        description=(
            "User interrupts a Gemini Live agent mid-utterance via scenario.interrupt(). "
            "Gemini has no client-side cancel, so the server's VAD must detect the "
            "overlap and cut the agent's reply."
        ),
        agents=[
            scenario.GeminiLiveAgentAdapter(
                model=GEMINI_LIVE_MODEL,
                voice="Algieba",
                system_instruction=(
                    "You are a verbose product expert. When asked about features, "
                    "list them at length. Keep going until the user stops you."
                ),
            ),
            # ElevenLabs voice "Sarah" — premade, free tier.
            scenario.UserSimulatorAgent(voice="elevenlabs/EXAVITQu4vr4xnSDxMaL"),
            scenario.JudgeAgent(
                criteria=[
                    "The agent recovered gracefully after being interrupted",
                    "The agent addressed the second topic (business hours) after the interrupt",
                    # Claims from docstring — server-VAD barge-in semantics.
                    "The agent's first reply was cut off mid-utterance by the user's interruption",
                    "The user simulator produced overlapping audio that the Gemini server detected as barge-in",
                    "The conversation is a coherent example of a Gemini Live server-VAD interrupt flow",
                ]
            ),
        ],
        script=[
            scenario.user("Tell me about every product feature you offer"),
            scenario.interrupt("Sorry one more thing — what are your business hours?"),
            scenario.agent(),
            scenario.judge(),
        ],
        max_turns=6,
    )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")

    if result.latency is not None:
        print(f"interrupt_response_time: {result.latency.interrupt_response_time}")

    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
