"""
Platform demo — ElevenLabs hosted Conversational AI.

What this demo proves:
    ElevenLabsAgentAdapter connects to
    wss://api.elevenlabs.io/v1/convai/conversation?agent_id=<ID> and runs a
    MULTI-TURN voice scenario over the real WebSocket transport where turns 2+
    are REAL voice-in: with turn_commit_mode="audio" (issue #705) the spoken PCM
    is streamed to EL's STT instead of being text-committed, so each scripted
    user turn gets a genuine ASR-driven agent response. Parity with the
    TypeScript twin javascript/examples/vitest/tests/voice/
    elevenlabs-705-real-audio-multiturn.test.ts.

AC: specs/voice-agents.feature "Demo — ElevenLabs hosted Conversational AI"
    Source §5.4, L760-776.

How to run:
    # 1. Provision the ElevenLabs test agent (creates ELEVENLABS_AGENT_ID in .env):
    make voice-elevenlabs-provision

    # 2. Run this demo:
    cd python
    uv run examples/voice/elevenlabs_hosted.py

Required env vars:
    OPENAI_API_KEY       — for JudgeAgent LLM
    ELEVENLABS_API_KEY   — ElevenLabs platform key
    ELEVENLABS_AGENT_ID  — ID of your hosted Conversational AI agent
                           (set by `make voice-elevenlabs-provision`)
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

REQUIRED_ENV = ("OPENAI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID")


def _check_env() -> None:
    missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
    if missing:
        sys.exit(f"Error: missing env vars: {missing}")


_check_env()

import scenario  # noqa: E402
from _recording_helper import save_demo_recording  # noqa: E402

scenario.configure(default_model="openai/gpt-5-mini")


async def main() -> tuple[scenario.ScenarioResult, scenario.ElevenLabsAgentAdapter]:
    # Real-audio commit mode (issue #705): stream the spoken PCM for every user
    # turn so EL's STT/VAD/turn-detector run on turns 2+, instead of
    # text-committing them. Pair with an agent provisioned for aggressive
    # turn-taking (scripts/provision_elevenlabs_agent.py). We hold the adapter
    # reference so the assertion below can prove the audio actually reached EL.
    agent = scenario.ElevenLabsAgentAdapter(
        agent_id=os.environ["ELEVENLABS_AGENT_ID"],
        api_key=os.environ["ELEVENLABS_API_KEY"],
        turn_commit_mode="audio",
    )
    result = await scenario.run(
        name="demo_elevenlabs_hosted",
        description=(
            "Multi-turn REAL voice-in against a live ElevenLabs Conversational AI "
            "agent. Greeting plays on connect (real-voice convention); the user "
            "asks across several turns and each scripted turn 2+ is streamed as "
            "real PCM to EL's STT (turn_commit_mode='audio', issue #705)."
        ),
        agents=[
            agent,
            scenario.UserSimulatorAgent(voice="openai/nova"),
            scenario.JudgeAgent(
                criteria=[
                    "The agent's initial greeting (sent on connect) is natural and conversational",
                    "The agent responded to each of the user's turns over multiple exchanges (no dropped turn)",
                    "The conversation is a coherent multi-turn example of the hosted ElevenLabs Conversational AI path",
                ]
            ),
        ],
        script=[
            # Real voice convention: EL sends first_message on connect. Lead with
            # agent() so the greeting drains before user audio hits the wire.
            # MULTI-TURN: with turn_commit_mode="audio" a scripted 2nd/3rd user
            # turn streams real PCM that EL's STT transcribes and the agent
            # responds to — the single-greeting-exchange ceiling is the #705 bug
            # of the default text-commit mode, NOT a hosted-ConvAI limit.
            scenario.agent(),
            scenario.user("Hello, I have a question about my account balance."),
            scenario.agent(),
            scenario.user("Thanks. What are your support hours this week?"),  # turn 2
            scenario.agent(),
            scenario.user("Okay — can you connect me to a human agent?"),  # turn 3
            scenario.agent(),
            scenario.judge(),
        ],
        max_turns=10,
    )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")
    print(
        f"real-voice commits: audio={agent.audio_commit_count} "
        f"text={agent.text_commit_count} "
        f"last_user_transcript={agent.last_user_transcript!r}"
    )
    save_demo_recording(getattr(result, "audio", None))
    return result, agent


if __name__ == "__main__":
    asyncio.run(main())
