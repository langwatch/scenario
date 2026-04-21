"""
Smoke 2: scenario answers an inbound Twilio call with TwilioAgentAdapter.

No separate bot needed — TwilioAgentAdapter IS the agent-under-test in this
smoke. The scenario script drives what it does. Useful for testing the
adapter surface end-to-end: FastAPI webhook → WS handler → µ-law codec →
send_audio/recv_audio.

Usage:

    python examples/voice_twilio_agent_answers_scenario.py
    # Script will print a cloudflared trycloudflare.com URL.
    # Scenario automatically registers it as the Twilio webhook.
    # Dial your Twilio number from a real phone within 60s.
    # Scenario records the conversation and prints the result.

Requires in python/.env:
    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TWILIO_PHONE_NUMBER  (E.164, e.g. +14155551234)
    OPENAI_API_KEY       (for UserSimulatorAgent TTS + JudgeAgent LLM)
"""

import asyncio
import os
import sys
from pathlib import Path


try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    # python-dotenv is optional — required env vars may already be exported
    # by the user's shell or CI. Missing dotenv just skips the .env load.
    pass


for key in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "OPENAI_API_KEY"):
    if not os.environ.get(key):
        sys.exit(f"Error: {key} is required. Set in python/.env.")


import scenario
from scenario.voice.testing import TwilioHarness


async def main() -> scenario.ScenarioResult:
    """Run the inbound smoke. Returns the ScenarioResult for caller inspection."""
    async with TwilioHarness(
        account_sid=os.environ["TWILIO_ACCOUNT_SID"],
        auth_token=os.environ["TWILIO_AUTH_TOKEN"],
        phone_number=os.environ["TWILIO_PHONE_NUMBER"],
    ) as adapter:
        print(f"Harness ready. Dial {os.environ['TWILIO_PHONE_NUMBER']} within 60s.")
        print(f"Webhook URL: {adapter.public_base_url}/twilio/voice")

        # Wait for a call to come in.
        await adapter.wait_for_call(timeout=60.0)
        print("Call connected — starting scenario run…")

        result = await scenario.run(
            name="twilio_inbound_smoke",
            description=(
                "A human caller dials in. Scenario greets them, has a brief "
                "exchange, then the user hangs up. Judge whether scenario's "
                "user-simulator sounded natural."
            ),
            agents=[
                adapter,
                scenario.UserSimulatorAgent(voice="openai/nova"),
                scenario.JudgeAgent(
                    criteria=[
                        "The user-sim greeted the caller without long silence",
                        "The conversation felt natural, not robotic",
                    ]
                ),
            ],
            max_turns=4,
        )

        print("=== result ===")
        print(f"success: {result.success}")
        print(f"verdict: {result.reasoning}")
        return result


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(main()).success else 1)
