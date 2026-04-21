"""
Platform demo — Twilio outbound (agent calls a human).

What this demo proves:
    TwilioAgentAdapter.place_call() dials a real phone number, the callee
    answers, the Media Streams WebSocket opens, and DTMF is received.

AC: specs/voice-agents.feature "Demo — Twilio outbound (agent calls a human)"

How to run:
    export TARGET_PHONE_NUMBER=+1...   # verified number in Twilio console
    python examples/voice_demo_twilio_outbound.py

Required env vars:
    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TWILIO_PHONE_NUMBER  — E.164 Twilio-owned number (caller ID)
    OPENAI_API_KEY
    TARGET_PHONE_NUMBER  — E.164 destination (must be verified for trial accounts)

Note:
    This is a human-in-the-loop demo. The e2e test skips without INTEGRATION_MANUAL=1.
"""

# Re-export from the original smoke scenario so we stay DRY.
# voice_twilio_simulator_calls_human_scenario.py is the canonical outbound demo.

from voice_twilio_simulator_calls_human_scenario import main  # type: ignore[import]

if __name__ == "__main__":
    import asyncio
    import sys

    sys.exit(0 if asyncio.run(main()) else 1)
