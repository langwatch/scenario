"""
Platform demo — Twilio inbound (simulator calls the agent's number).

Runs end-to-end using two Twilio numbers — no human required.

What this demo proves:
    TwilioAgentAdapter.wait_for_call() accepts an inbound call on
    TWILIO_PHONE_NUMBER, while TWILIO_PHONE_NUMBER_2 (simulator) dials in via
    place_call(). Media Streams WebSockets open on both sides and JudgeAgent
    confirms the exchange succeeded.

AC: specs/voice-agents.feature "Demo — Twilio inbound"

How to run:
    cd python
    uv run examples/voice/twilio_inbound.py

Required env vars:
    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TWILIO_PHONE_NUMBER   — E.164 Twilio number (agent / callee)
    TWILIO_PHONE_NUMBER_2 — E.164 Twilio number (user-simulator / caller)
    OPENAI_API_KEY        — for UserSimulatorAgent TTS + JudgeAgent LLM
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
from scenario.types import AgentRole  # noqa: E402
from scenario.voice.testing import TwilioHarness  # noqa: E402

scenario.configure(default_model="openai/gpt-5-mini")


async def main() -> scenario.ScenarioResult:
    """Run the inbound demo. Simulator dials in; agent answers."""
    # Agent side: TWILIO_PHONE_NUMBER answers the inbound call.
    # User-sim side: TWILIO_PHONE_NUMBER_2 places the outbound call.
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
            # Mark the simulator adapter as USER so scenario routes it correctly.
            sim_adapter.role = AgentRole.USER  # type: ignore[misc]

            print(
                f"Agent ready on {os.environ['TWILIO_PHONE_NUMBER']} "
                f"(waiting for call)."
            )
            print(
                f"Simulator will call from {os.environ['TWILIO_PHONE_NUMBER_2']}."
            )

            # Start wait_for_call on the agent side first, then place_call on
            # the sim side so there's a listener ready before the ring.
            agent_wait = asyncio.create_task(
                agent_adapter.wait_for_call(timeout=60.0)
            )
            await asyncio.sleep(1.0)  # give the webhook a beat to register

            await sim_adapter.place_call(
                to=os.environ["TWILIO_PHONE_NUMBER"],
                timeout=60.0,
            )
            await agent_wait  # both sides now have live media streams

            result = await scenario.run(
                name="twilio_inbound_demo",
                description=(
                    "A cheerful user calls the agent, says hello, and hangs up. "
                    "Judge whether both sides exchanged audio without errors and "
                    "the call completed within the time limit."
                ),
                agents=[
                    agent_adapter,
                    sim_adapter,
                    scenario.JudgeAgent(
                        criteria=[
                            "The agent-side received audio from the caller",
                            "The call completed gracefully without transport errors",
                            # Claim from docstring: TwilioAgentAdapter.wait_for_call() inbound + place_call() simulator.
                            "An inbound Twilio call was accepted and a Media Streams WebSocket opened on each side",
                            "The conversation is a coherent example of the Twilio-inbound path",
                        ]
                    ),
                ],
                max_turns=3,
            )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(main()).success else 1)
