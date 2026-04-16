"""
Smoke 4: two-number automated self-test over real Twilio PSTN.

Exercises the full caller ↔ answerer pipeline end-to-end without any human
on the line:

    adapter A (caller)    adapter B (answerer)
    TWILIO_PHONE_NUMBER_2 → TWILIO_PHONE_NUMBER
    place_call()            wait_for_call()

Twilio bridges the two numbers across real PSTN. A sends a 440Hz tone; B
receives non-silent µ-law and asserts it. B sends an 880Hz tone back; A
asserts it in return. Both legs round-trip → smoke passes.

This is the real-network sibling of the in-process loopback test in
``tests/voice/test_twilio_two_adapter_bridge.py``. The loopback test
proves the frame protocol is symmetric (no Twilio required). This smoke
proves the whole transport — µ-law codec, Media Streams WS, cloudflared
tunnel, Twilio REST — works over the actual telco network.

Cost: ~$0.02 per run (two ~30s domestic legs). Cheap enough for occasional
manual validation, expensive enough to keep out of every CI build.

Requires in python/.env:
    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TWILIO_PHONE_NUMBER     — answerer
    TWILIO_PHONE_NUMBER_2   — caller
    (OPENAI_API_KEY not needed; this smoke tests the transport directly.)
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path


try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass


REQUIRED = (
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "TWILIO_PHONE_NUMBER_2",
)
for key in REQUIRED:
    if not os.environ.get(key):
        sys.exit(f"Error: {key} is required. Set in python/.env.")


import numpy as np

from scenario.voice import AudioChunk, TwilioAgentAdapter
from scenario.voice.testing import TwilioHarness


def _tone_pcm16_24k(duration_s: float, freq: float) -> bytes:
    """PCM16 24kHz mono sine wave. AudioChunk canonical format."""
    t = np.arange(int(duration_s * 24000)) / 24000
    signal = (np.sin(2 * np.pi * freq * t) * 16000).astype(np.int16)
    return signal.tobytes()


async def _drain_until_audible(
    adapter_name: str,
    adapter: TwilioAgentAdapter,
    max_chunks: int = 10,
    min_peak: int = 1000,
    per_chunk_timeout: float = 3.0,
) -> bool:
    """Pull up to `max_chunks` chunks from adapter until one has peak > min_peak.

    Returns True if a non-silent chunk arrived, False otherwise.
    """
    for i in range(max_chunks):
        try:
            chunk = await adapter.recv_audio(timeout=per_chunk_timeout)
        except asyncio.TimeoutError:
            print(f"  {adapter_name}: no audio within {per_chunk_timeout}s on chunk {i}")
            return False
        arr = np.frombuffer(chunk.data, dtype=np.int16)
        peak = int(np.abs(arr).max()) if len(arr) else 0
        print(f"  {adapter_name}: chunk {i} {len(chunk.data)}B, peak={peak}")
        if peak > min_peak:
            return True
    return False


async def main() -> int:
    answerer_number = os.environ["TWILIO_PHONE_NUMBER"]
    caller_number = os.environ["TWILIO_PHONE_NUMBER_2"]

    print("=== Two-number self-test ===")
    print(f"  caller  : {caller_number}")
    print(f"  answerer: {answerer_number}")

    async with TwilioHarness(
        account_sid=os.environ["TWILIO_ACCOUNT_SID"],
        auth_token=os.environ["TWILIO_AUTH_TOKEN"],
        phone_number=answerer_number,
        http_port=8765,
    ) as answerer, TwilioHarness(
        account_sid=os.environ["TWILIO_ACCOUNT_SID"],
        auth_token=os.environ["TWILIO_AUTH_TOKEN"],
        phone_number=caller_number,
        http_port=8766,
    ) as caller:
        print(f"  answerer tunnel: {answerer.public_base_url}")
        print(f"  caller   tunnel: {caller.public_base_url}")

        # Let cloudflared edges settle before Twilio starts hitting them.
        print("\nWaiting 5s for tunnels + Twilio propagation...")
        await asyncio.sleep(5)

        # Kick off both directions concurrently. Twilio rings the answerer,
        # the answerer's webhook returns <Connect><Stream>, Twilio opens WS
        # back to the answerer. At the same time, the caller's place_call()
        # REST call triggers Twilio to hit the caller's TwiML URL, which
        # returns <Connect><Stream>, Twilio opens WS back to the caller.
        # Both `_stream_connected` events fire once both legs are live.
        print("Placing call...")
        answerer_task = asyncio.create_task(answerer.wait_for_call(timeout=45.0))
        caller_task = asyncio.create_task(
            caller.place_call(to=answerer_number, timeout=45.0)
        )

        try:
            await asyncio.gather(answerer_task, caller_task)
        except asyncio.TimeoutError:
            print("FAIL: at least one leg didn't open its media stream within 45s.")
            return 1

        print("Both media streams live.")

        # Leg 1: caller → answerer.
        print("\nLeg 1: caller sends 440Hz tone.")
        await caller.send_audio(AudioChunk(data=_tone_pcm16_24k(1.0, 440)))
        if not await _drain_until_audible("answerer", answerer):
            print("FAIL: answerer did not receive non-silent audio from caller.")
            return 1
        print("  PASS: caller → answerer audio flowed.")

        # Leg 2: answerer → caller.
        print("\nLeg 2: answerer sends 880Hz tone.")
        await answerer.send_audio(AudioChunk(data=_tone_pcm16_24k(1.0, 880)))
        if not await _drain_until_audible("caller", caller):
            print("FAIL: caller did not receive non-silent audio from answerer.")
            return 1
        print("  PASS: answerer → caller audio flowed.")

        print("\nAll legs round-tripped. Tearing down...")

    print("=== SUCCESS ===")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
