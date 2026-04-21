"""
Example 6.4 — DTMF IVR navigation.

What this demo proves:
    scenario.dtmf("1") emits a real DTMF tone through TwilioAgentAdapter and
    the agent (IVR) routes the caller to the billing department.

AC: specs/voice-agents.feature "Example 6.4 — DTMF IVR navigation"
    Source §6.4, L969-996.

How to run:
    cd python
    uv run examples/voice_example_6_4_dtmf_ivr.py

Required env vars:
    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TWILIO_PHONE_NUMBER  — E.164 Twilio number
    OPENAI_API_KEY       — for UserSimulatorAgent TTS + JudgeAgent LLM

Note:
    This demo requires a live Twilio account and a running IVR. The e2e test
    skips without all four env vars.  The TwilioHarness starts a local webhook
    server and registers it automatically.
"""

import asyncio
import os
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

REQUIRED_ENV = (
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "OPENAI_API_KEY",
)


def _check_env() -> None:
    missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
    if missing:
        sys.exit(f"Error: missing env vars: {missing}")


_check_env()

import scenario  # noqa: E402
from scenario.voice.testing import TwilioHarness  # noqa: E402

scenario.configure(default_model="openai/gpt-4.1-mini")


async def main() -> scenario.ScenarioResult:
    async with TwilioHarness(
        account_sid=os.environ["TWILIO_ACCOUNT_SID"],
        auth_token=os.environ["TWILIO_AUTH_TOKEN"],
        phone_number=os.environ["TWILIO_PHONE_NUMBER"],
    ) as adapter:
        print(f"Harness ready. Waiting for call on {os.environ['TWILIO_PHONE_NUMBER']}…")
        await adapter.wait_for_call(timeout=60.0)

        result = await scenario.run(
            name="example_6_4_dtmf_ivr",
            description=(
                "Caller navigates an IVR: press 1 for billing. "
                "Judge: agent routed the caller to billing after DTMF."
            ),
            agents=[
                adapter,
                scenario.UserSimulatorAgent(voice="openai/nova"),
                scenario.JudgeAgent(
                    criteria=[
                        "The agent announced billing as the destination for pressing 1",
                        "The agent routed the caller after receiving DTMF tone 1",
                    ]
                ),
            ],
            script=[
                scenario.agent(),
                scenario.dtmf("1"),
                scenario.agent(),
                scenario.judge(),
            ],
            max_turns=6,
        )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    return result


if __name__ == "__main__":
    asyncio.run(main())
