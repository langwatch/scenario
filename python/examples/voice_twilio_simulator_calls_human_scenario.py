"""
Smoke 3: scenario places an outbound Twilio call and validates DTMF input.

Deterministic assertion (no 'judge the vibes'):
    - scenario's user-sim says "Press 1 then hang up"
    - scenario waits for on_dtmf("1") within 60s
    - if DTMF received, success; if timeout, failure.

This is a human-in-the-loop smoke: a real person must answer the phone
and press 1. The long (60s) timeout tolerates TTS latency + human reaction.

Usage:

    export TARGET_PHONE_NUMBER=+1...   # your cell, verified in Twilio console
    python examples/voice_twilio_simulator_calls_human_scenario.py

Requires in python/.env:
    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TWILIO_PHONE_NUMBER    (E.164 — the Twilio-owned number to call FROM)
    OPENAI_API_KEY

Requires in environment:
    TARGET_PHONE_NUMBER    (E.164 — YOUR number to call; must be verified
                            in Twilio console for trial accounts)
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

if not os.environ.get("TARGET_PHONE_NUMBER"):
    sys.exit(
        "Error: TARGET_PHONE_NUMBER is required (E.164, e.g. +14155551234). "
        "Must be a Verified Caller ID on Twilio trial accounts."
    )
TARGET: str = os.environ["TARGET_PHONE_NUMBER"]


from scenario.voice.testing import TwilioHarness


async def main() -> None:
    # Collect DTMF digits as they arrive.
    received: list[str] = []

    def on_dtmf(digit: str) -> None:
        print(f"[dtmf] received: {digit}")
        received.append(digit)

    async with TwilioHarness(
        account_sid=os.environ["TWILIO_ACCOUNT_SID"],
        auth_token=os.environ["TWILIO_AUTH_TOKEN"],
        phone_number=os.environ["TWILIO_PHONE_NUMBER"],
        on_dtmf=on_dtmf,
    ) as adapter:
        print(f"Placing outbound call from {os.environ['TWILIO_PHONE_NUMBER']} to {TARGET}…")
        # place_call() blocks until the media stream is live (callee answered).
        await adapter.place_call(to=TARGET, timeout=45.0)
        print("Call connected.")

        # Play a simple TTS instruction directly on the outbound leg. We skip
        # scenario.run() here because this smoke's purpose is just: does
        # place_call() + send_audio() + on_dtmf actually work?
        from scenario.voice import synthesize

        chunk = await synthesize(
            text="Hello! Please press one on your keypad, then hang up. Thank you.",
            voice="openai/nova",
        )
        await adapter.send_audio(chunk)
        print("Instruction sent. Waiting for DTMF '1' (60s timeout)…")

        # Poll up to 60s for the expected digit.
        for _ in range(60):
            if "1" in received:
                break
            await asyncio.sleep(1.0)

        if "1" in received:
            print("=== SUCCESS ===")
            print("Outbound smoke passed: caller pressed 1, on_dtmf fired correctly.")
            print(f"All digits received: {received}")
            sys.exit(0)
        else:
            print("=== FAILURE ===")
            print(f"Did not receive DTMF '1' within 60s. Digits received: {received or '(none)'}")
            sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
