"""
Smoke 1: scenario drives a pipecat voice bot via PipecatAgentAdapter.

Prerequisite: in a separate terminal, run the bot + a tunnel:

    # Terminal A — start the bot
    cd python
    pip install "pipecat-ai[openai,websockets,runner]"
    python examples/voice/_pipecat_twilio_bot.py --host 0.0.0.0 --port 8765

    # Terminal B — expose it to Twilio
    cloudflared tunnel --url http://localhost:8765
    # Copy the *.trycloudflare.com URL into your Twilio number's Voice webhook:
    #   Console → Phone Numbers → Active Numbers → click number → set "A call
    #   comes in" to "Webhook", URL = https://foo-bar.trycloudflare.com/

    # Terminal C — run this scenario
    python examples/voice/pipecat_scenario.py

Then dial your Twilio number from a real phone. Scenario connects directly to
the bot over WS (bypassing Twilio for scenario↔bot signaling) and records
the conversation.

Requires OPENAI_API_KEY in python/.env.
"""

import asyncio
import os
import sys
from pathlib import Path


try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")
except ImportError:
    # python-dotenv is optional — required env vars may already be exported
    # by the user's shell or CI. Missing dotenv just skips the .env load.
    pass


if not os.environ.get("OPENAI_API_KEY"):
    sys.exit("Error: OPENAI_API_KEY is required. Set in python/.env.")


import scenario
from _bot_lifecycle import ensure_pipecat_bot  # noqa: E402
from _recording_helper import save_demo_recording  # noqa: E402

scenario.configure(default_model="openai/gpt-5-mini")

BOT_WS_URL = os.environ.get("PIPECAT_BOT_URL", "ws://localhost:8765/stream")


async def main(demo_name: str = "pipecat_scenario") -> scenario.ScenarioResult:
    """Run the Pipecat smoke scenario. Returns the ScenarioResult.

    `demo_name` controls which outputs/recordings/<name>/ dir the artifacts
    land in. Defaults to 'pipecat_scenario'; pipecat_ws.py overrides to keep
    its recording separate from this demo's.
    """
    async with ensure_pipecat_bot():
        result = await scenario.run(
            name="pipecat_twilio_smoke",
            description=(
                "A caller rings the phone bot. The bot greets them and "
                "answers a brief question. Scenario records the conversation and "
                "judges whether the bot was friendly and informative."
            ),
            agents=[
                scenario.PipecatAgentAdapter(
                    url=BOT_WS_URL,
                    audio_format="mulaw",
                    sample_rate=8000,
                ),
                scenario.UserSimulatorAgent(voice="openai/nova"),
                scenario.JudgeAgent(
                    criteria=[
                        "The bot responded conversationally (not robotic)",
                        "The bot stayed on topic when the caller asked a question",
                        # Claim: PipecatAgentAdapter against the bundled stub bot drives a real WebSocket exchange.
                        "The agent and user exchanged real audio turns over the live Pipecat WebSocket",
                        "The conversation is a coherent example of a Pipecat-driven voice scenario",
                    ]
                ),
            ],
            # Explicit turn-taking — prevents both-sides-waiting deadlock against
            # simple stub bots by having the user-sim speak first.
            script=[
                scenario.user("Hi! Can you help me with a question about my account?"),
                scenario.agent(),
                scenario.user("What are your hours?"),
                scenario.agent(),
                scenario.judge(),
            ],
        )

    print("=== result ===")
    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    if result.audio is not None:
        print(f"audio: {len(result.audio.segments)} segments recorded")
    save_demo_recording(getattr(result, "audio", None), demo_name=demo_name)
    return result


if __name__ == "__main__":
    import sys as _sys

    _sys.exit(0 if asyncio.run(main()).success else 1)
