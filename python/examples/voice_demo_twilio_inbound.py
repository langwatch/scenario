"""
Platform demo — Twilio inbound (human dials in).

What this demo proves:
    TwilioAgentAdapter.wait_for_call() accepts a real inbound call, the Media
    Streams WebSocket opens, and result.success is True after one turn.

AC: specs/voice-agents.feature "Demo — Twilio inbound (human dials in)"

How to run:
    python examples/voice_demo_twilio_inbound.py
    # Dial TWILIO_PHONE_NUMBER from your phone within 60s.

Required env vars:
    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TWILIO_PHONE_NUMBER  — E.164 Twilio number
    OPENAI_API_KEY       — for UserSimulatorAgent TTS + JudgeAgent LLM

Note:
    This is a human-in-the-loop demo. The e2e test skips without INTEGRATION_MANUAL=1.
"""

# Re-export from the original smoke scenario so we stay DRY.
# voice_twilio_agent_answers_scenario.py is the canonical inbound demo.

from voice_twilio_agent_answers_scenario import main  # type: ignore[import]

if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
