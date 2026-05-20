"""
Platform demo — Twilio inbound (real PSTN call, scenario user-simulator).

What this demo proves:
    TwilioAgentAdapter accepts a real inbound PSTN call on
    ``TWILIO_PHONE_NUMBER`` and exchanges audio with the scenario's
    UserSimulatorAgent over Twilio Media Streams. The simulator's TTS-rendered
    user audio flows through the adapter's Media Streams WS to the caller's
    ear; the caller's audio comes back via the same WS to recv_audio.

    To exercise this without a human, we use a second Twilio number
    (``TWILIO_PHONE_NUMBER_2``) as a simple call-originator — it dials
    the agent's number with inline TwiML that just connects the two PSTN
    legs (``<Dial><Number>``). The agent's adapter handles the call
    end-to-end via Media Streams; the originator leg is the conduit that
    causes the agent's number to ring.

    This is the same topology the SDK uses when a developer tests their
    deployed Twilio agent against an external caller — the agent owns
    Media Streams; the caller is just a PSTN endpoint dialing in.

AC: specs/voice-agents.feature "Demo — Twilio inbound"

How to run:
    cd python
    uv run examples/voice/twilio_inbound.py

Required env vars:
    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TWILIO_PHONE_NUMBER   — E.164 Twilio number (agent / callee). The adapter
                            answers inbound calls on this number.
    TWILIO_PHONE_NUMBER_2 — E.164 Twilio number used to originate the test
                            call into ``TWILIO_PHONE_NUMBER``.
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
from scenario.voice.adapters._twilio_shared import TwilioRESTHelper  # noqa: E402
from scenario.voice.testing import TwilioHarness  # noqa: E402

scenario.configure(default_model="openai/gpt-5-mini")


async def _dial_in_from_second_number(*, account_sid: str, auth_token: str, from_number: str, to_number: str) -> str:
    """Originate a call from ``from_number`` to ``to_number`` with inline TwiML.

    The inline TwiML simply <Pause>s long enough for the scenario to run.
    Twilio's call routing connects from_number → to_number on PSTN, which
    causes to_number's voice_url (set by the agent harness) to fire and
    open the Media Streams WS.

    Returns the originator call SID so the caller can cancel it on teardown.
    """
    helper = TwilioRESTHelper(account_sid, auth_token)
    # The originator leg plays a short deterministic <Say> line, then
    # pauses for the rest of the scenario. The <Say> gives the recording
    # a known-good English utterance to transcribe (without it, the
    # agent-side captures 25s of line silence/noise and Whisper has been
    # observed to hallucinate non-English text — see #465).
    inline = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        '<Say voice="Polly.Joanna">'
        "Thank you for calling. I will hold the line while you complete your scenario."
        "</Say>"
        '<Pause length="120"/>'
        "</Response>"
    )
    return await asyncio.to_thread(
        helper.place_call,
        to=to_number,
        from_=from_number,
        twiml=inline,
    )


async def main() -> scenario.ScenarioResult:
    """Run the inbound demo. Second number dials in; agent answers via Media Streams."""
    account_sid = os.environ["TWILIO_ACCOUNT_SID"]
    auth_token = os.environ["TWILIO_AUTH_TOKEN"]
    agent_number = os.environ["TWILIO_PHONE_NUMBER"]
    originator_number = os.environ["TWILIO_PHONE_NUMBER_2"]

    async with TwilioHarness(
        account_sid=account_sid,
        auth_token=auth_token,
        phone_number=agent_number,
        http_port=8766,
    ) as agent_adapter:
        # Start wait_for_call BEFORE originating the call so the webhook
        # is ready when Twilio fetches it.
        agent_wait = asyncio.create_task(
            agent_adapter.wait_for_call(timeout=120.0)
        )
        # Give the webhook a beat to settle.
        await asyncio.sleep(2.0)

        originator_call_sid = await _dial_in_from_second_number(
            account_sid=account_sid,
            auth_token=auth_token,
            from_number=originator_number,
            to_number=agent_number,
        )
        print(f"Originator call placed: {originator_call_sid}")

        # Block until the agent's Media Streams WS is live.
        # `_ =` silences code-quality's "statement has no effect" false
        # positive — awaiting the Task IS the effect.
        _ = await agent_wait
        print(f"Agent stream live on {agent_number}.")

        result = await scenario.run(
            name="twilio_inbound_demo",
            description=(
                "A second Twilio number dials into the agent's Twilio number. "
                "The agent adapter accepts the inbound call and exchanges audio "
                "with scenario's UserSimulatorAgent via Media Streams. "
                "Judge whether the agent received audio and the call completed "
                "gracefully."
            ),
            agents=[
                agent_adapter,
                scenario.UserSimulatorAgent(voice="openai/nova"),
                scenario.JudgeAgent(
                    criteria=[
                        "The agent received audio from the user simulator",
                        "The agent and user exchanged audio turns via Media Streams",
                        "The call completed without transport errors",
                        # Guard against the silent-line-noise-transcribed-as-gibberish failure mode (#465).
                        "Any captured agent audio transcribes as coherent English (not nonsense or non-English text)",
                    ]
                ),
            ],
            script=[
                scenario.user("Hello, I have a quick question."),
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
