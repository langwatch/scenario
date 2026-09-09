"""
Live a-leg external-number smoke (scenario#762 Slice 5, AC11) — env-gated.

Dials a real external number over a real Cloudflare tunnel and runs a scenario
over the Media Stream attached to OUR OWN leg. It bills a PSTN call, so it never
runs unless the operator has explicitly named the destination in
``SCENARIO_TWILIO_EXTERNAL_TO``; absent that, the fixture skips (#796 option b).

The ungated standing proof of the same frame loop is
``test_twilio_frame_loop.py`` (AC14) — this test is what an operator runs once
against a real deployed agent, not something CI can carry.

How to run (operator, from ``python/``)::

    TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... \\
    TWILIO_PHONE_NUMBER=+1415... SCENARIO_TWILIO_EXTERNAL_TO=+4479... \\
    OPENAI_API_KEY=... uv run pytest tests/voice/test_twilio_a_leg_external_e2e.py

Binds AC11 of ``specs/voice-twilio-a-leg-external.feature``.
"""

from __future__ import annotations

import os

import pytest

import scenario
from scenario.voice.testing import TwilioHarness

#: What the user simulator opens with. The assertion below looks for this
#: prompt's audio actually leaving on the sendAudio direction, and for the
#: callee's spoken reply coming back transcribed — the two halves AC11 asks for.
OUTBOUND_PROMPT = "Hello, I am calling to test this line. Can you hear me?"

#: Ceiling on a billed external call. Belt (adapter timer) and suspenders
#: (Twilio TimeLimit) both derive from this.
MAX_CALL_DURATION_SECONDS = 180


#: pytest.ini pins ``timeout = 60`` for the whole suite; this test legitimately
#: outlives that (120s stream-connect wait + up to 180s of call + LLM turns), and
#: pytest-timeout killing the process mid-call skips the adapter's own hangup.
#: The adapter's guards (stream-connect timeout, max_call_duration_seconds,
#: Twilio TimeLimit) are the real ceilings — this only has to sit above them.
PYTEST_TIMEOUT_SECONDS = 600


@pytest.mark.timeout(PYTEST_TIMEOUT_SECONDS)
@pytest.mark.asyncio
async def test_a_leg_external_call_exchanges_audio_both_directions(
    requires_twilio_a_leg_external,
):
    """A-leg dials an external number and audio flows in both directions.

    Bidirectional evidence, not "audio was heard": frames_received counts the
    inbound media frames the a-leg socket actually decoded, and the transcribed
    assistant turns are the STT read of that same audio.
    """
    external_to = os.environ["SCENARIO_TWILIO_EXTERNAL_TO"]

    async with TwilioHarness(
        account_sid=os.environ["TWILIO_ACCOUNT_SID"],
        auth_token=os.environ["TWILIO_AUTH_TOKEN"],
        phone_number=os.environ["TWILIO_PHONE_NUMBER"],
        # Deny-by-default (#762 guardrail (c)): the destination the operator
        # named in env is the only number this adapter may dial.
        allowed_callees=[external_to],
        http_port=8767,
    ) as adapter:
        await adapter.place_call(
            to=external_to,
            attach_stream="a-leg",
            timeout=120.0,
            max_call_duration_seconds=MAX_CALL_DURATION_SECONDS,
        )

        result = await scenario.run(
            name="twilio_a_leg_external_smoke",
            description=(
                "The adapter dials an external number and attaches the Media "
                "Stream to its own leg via <Connect><Stream>. The user "
                "simulator speaks over that stream and the callee's replies "
                "come back on it."
            ),
            agents=[
                adapter,
                scenario.UserSimulatorAgent(voice="openai/nova"),
                scenario.JudgeAgent(
                    criteria=[
                        "The callee received the caller's spoken audio",
                        "The callee's spoken reply came back over the media stream",
                        "The call completed without transport errors",
                    ]
                ),
            ],
            script=[
                scenario.user(OUTBOUND_PROMPT),
                scenario.agent(),
                scenario.judge(),
            ],
            max_turns=4,
        )

        # Sampled inside the harness: disconnect() resets the counters.
        frames_received = adapter._frames_received

    assert frames_received > 0, (
        "no inbound media frames decoded — the a-leg socket carried no audio"
    )
    transcribed = [
        m
        for m in result.messages
        if m.get("role") == "assistant" and str(m.get("content") or "").strip()
    ]
    assert transcribed, (
        "no transcribed reply from the callee — the return direction is unproven"
    )
    assert result.success, f"Expected success; verdict: {result.reasoning}"
