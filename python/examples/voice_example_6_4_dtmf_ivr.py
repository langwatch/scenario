"""
Example 6.4 — DTMF IVR navigation.

Runs end-to-end using two Twilio numbers — no human required.

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
    TWILIO_PHONE_NUMBER   — E.164 Twilio number (IVR agent / callee)
    TWILIO_PHONE_NUMBER_2 — E.164 Twilio number (user-simulator / caller)
    OPENAI_API_KEY        — for UserSimulatorAgent TTS + JudgeAgent LLM
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
    "TWILIO_PHONE_NUMBER_2",
    "OPENAI_API_KEY",
)


def _check_env() -> None:
    missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
    if missing:
        sys.exit(f"Error: missing env vars: {missing}")


_check_env()

import scenario  # noqa: E402
from scenario.types import AgentRole  # noqa: E402
from scenario.voice.testing import TwilioHarness  # noqa: E402

scenario.configure(default_model="openai/gpt-4.1-mini")


async def main() -> scenario.ScenarioResult:
    """Run the DTMF IVR demo. Simulator calls the IVR, presses 1, agent routes to billing."""
    # Agent side (IVR): TWILIO_PHONE_NUMBER waits for the inbound call.
    # Simulator side: TWILIO_PHONE_NUMBER_2 places the call and sends DTMF.
    async with TwilioHarness(
        account_sid=os.environ["TWILIO_ACCOUNT_SID"],
        auth_token=os.environ["TWILIO_AUTH_TOKEN"],
        phone_number=os.environ["TWILIO_PHONE_NUMBER"],
        http_port=8766,
    ) as agent_adapter:
        async with TwilioHarness(
            account_sid=os.environ["TWILIO_ACCOUNT_SID"],
            auth_token=os.environ["TWILIO_AUTH_TOKEN"],
            phone_number=os.environ["TWILIO_PHONE_NUMBER_2"],
            http_port=8767,
        ) as sim_adapter:
            sim_adapter.role = AgentRole.USER  # type: ignore[misc]

            print(
                f"IVR agent ready on {os.environ['TWILIO_PHONE_NUMBER']} "
                f"(waiting for call)."
            )

            agent_wait = asyncio.create_task(
                agent_adapter.wait_for_call(timeout=60.0)
            )
            await asyncio.sleep(1.0)

            await sim_adapter.place_call(
                to=os.environ["TWILIO_PHONE_NUMBER"],
                timeout=60.0,
            )
            await agent_wait

            result = await scenario.run(
                name="example_6_4_dtmf_ivr",
                description=(
                    "Caller navigates an IVR: press 1 for billing. "
                    "Judge: agent routed the caller to billing after DTMF."
                ),
                agents=[
                    agent_adapter,
                    sim_adapter,
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
