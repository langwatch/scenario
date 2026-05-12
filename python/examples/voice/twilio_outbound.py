"""
Platform demo — Twilio outbound (real PSTN call originated by the adapter).

What this demo proves:
    TwilioAgentAdapter.place_call() originates a real outbound PSTN call
    from ``TWILIO_PHONE_NUMBER_2`` to ``TWILIO_PHONE_NUMBER`` and exchanges
    audio with the scenario's UserSimulatorAgent over Twilio Media Streams.

    Number mapping convention (shared with twilio_inbound.py):
      - ``TWILIO_PHONE_NUMBER`` is the number that must actually terminate
        inbound voice calls. Required because Twilio Media Streams needs
        the callee leg to be reachable.
      - ``TWILIO_PHONE_NUMBER_2`` is the originator. Just needs to be a
        valid Twilio number that can place outbound calls.

    Both legs run Connect+Stream TwiML against this adapter's webhook;
    the originating leg's <Connect><Stream> is what carries the audio for
    the scenario. The callee leg is just the call-setup conduit.

AC: specs/voice-agents.feature "Demo — Twilio outbound"

How to run:
    cd python
    uv run examples/voice/twilio_outbound.py

Required env vars:
    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TWILIO_PHONE_NUMBER    — E.164 Twilio number that terminates voice
                             (the destination of the outbound call).
    TWILIO_PHONE_NUMBER_2  — E.164 Twilio number that originates the call.
    OPENAI_API_KEY         — for UserSimulatorAgent TTS + JudgeAgent LLM
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

REQUIRED_ENV = (
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "TWILIO_PHONE_NUMBER_2",
    "OPENAI_API_KEY",
)


def _check_env() -> None:
    missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
    if missing:
        sys.exit(f"Error: missing env vars: {missing}")


_check_env()

import scenario  # noqa: E402
from _recording_helper import save_demo_recording  # noqa: E402
from scenario.voice.testing import TwilioHarness  # noqa: E402


scenario.configure(default_model="openai/gpt-5-mini")


async def main() -> scenario.ScenarioResult:
    """Run the outbound demo. Adapter places a call to the terminating number."""
    account_sid = os.environ["TWILIO_ACCOUNT_SID"]
    auth_token = os.environ["TWILIO_AUTH_TOKEN"]
    originator_number = os.environ["TWILIO_PHONE_NUMBER_2"]
    callee_number = os.environ["TWILIO_PHONE_NUMBER"]

    async with TwilioHarness(
        account_sid=account_sid,
        auth_token=auth_token,
        phone_number=originator_number,
        http_port=8766,
    ) as agent_adapter:
        await agent_adapter.place_call(to=callee_number, timeout=120.0)
        print(f"Outbound call live from {originator_number} to {callee_number}.")

        result = await scenario.run(
            name="twilio_outbound_demo",
            description=(
                "Agent adapter dials out from one Twilio number to another. "
                "Scenario's UserSimulatorAgent plays the user role over "
                "Media Streams; judge evaluates that audio exchanged "
                "successfully and the call completed without transport "
                "errors."
            ),
            agents=[
                agent_adapter,
                scenario.UserSimulatorAgent(voice="openai/nova"),
                scenario.JudgeAgent(
                    criteria=[
                        "The agent received audio from the user simulator",
                        "The agent and user exchanged audio turns via Media Streams",
                        "The call completed without transport errors",
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
    sys.exit(0 if asyncio.run(main()).success else 1)
