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
    GEMINI_API_KEY   — Gemini Live agent + judge LLM
    OPENAI_API_KEY   — UserSimulatorAgent TTS voice
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

REQUIRED_ENV = ("GEMINI_API_KEY", "OPENAI_API_KEY")


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
                    "You are a helpful assistant that gives long, detailed answers."
                ),
            ),
            scenario.UserSimulatorAgent(voice="openai/nova"),
            scenario.JudgeAgent(
                criteria=[
                    # The mechanism we're proving: the user's new turn
                    # arrives while the model is mid-reply, the server
                    # cuts the in-flight audio, and the cancelled turn's
                    # audio block in the conversation is markedly shorter
                    # than a full reply.
                    "The agent's first reply was cut off mid-utterance — its audio block is short relative to the verbose first user turn",
                    "The user simulator produced TWO distinct user turns, the second arriving before the agent finished the first",
                    "The conversation transcript is a coherent example of a mid-utterance interrupt landing on Gemini Live",
                ]
            ),
        ],
        script=[
            scenario.user("Tell me everything you can about your platform"),
            # 12s wait_for_speech_timeout — Gemini's first-audio latency
            # for verbose prompts can exceed the 8s default; this gives
            # the model time to start before we barge in.
            scenario.interrupt(
                "Sorry, one more thing — what are your business hours?",
                wait_for_speech_timeout=12.0,
            ),
            # Drain whatever Gemini emits after the interrupt. The recovery
            # reply may be terse (server-VAD interrupts on Gemini sometimes
            # produce <100ms of post-cancel audio); the demo asserts the
            # interrupt MECHANISM, not the model's recovery prose.
            scenario.agent(),
            scenario.judge(),
        ],
        max_turns=8,
    )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")

    if result.latency is not None:
        print(f"interrupt_response_time: {result.latency.interrupt_response_time}")

    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
