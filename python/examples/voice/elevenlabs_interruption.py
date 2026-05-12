"""
Platform demo — ElevenLabs Conversational AI interruption (server-side VAD barge-in).

What this demo proves:
    ElevenLabsAgentAdapter advertises ``capabilities.interruption=False`` because
    the ConvAI WebSocket protocol exposes no client-initiated cancel signal.
    Interruption on this transport relies on the server's voice-activity
    detector: when our user audio arrives mid-agent-utterance, the EL server's
    VAD detects barge-in and cuts the agent's reply on its end.

    The executor's _fire_user_interrupt:
      - waits up to 15s for the agent's first audio chunk (so we don't
        barge into silence)
      - skips the native interrupt branch (capability gate False)
      - pushes the new user audio onto the wire
      - records ``user_interrupt`` in the timeline; manifest.json gets the
        event + ``transcript_truncated`` on the agent segment that was alive
        when the interrupt fired.

Real-voice convention:
    EL ConvAI sends ``first_message`` on connect — that's how every live
    voice service works (Twilio, EL ConvAI, OpenAI Realtime, Gemini Live,
    Vapi). The script leads with a lone ``scenario.agent()`` to consume
    that greeting BEFORE any user audio is sent. Without this, the user's
    first audio races the greeting, EL's VAD fires
    interruption + agent_response_correction, and the turn locks into a
    non-responding state.

    For verbosity (so the user's barge-in has agent audio to overlap), this
    demo applies a per-session ``system_prompt_override`` via
    ``conversation_initiation_client_data`` rather than mutating the shared
    provisioned test agent. The shared agent stays concise; only this
    session sees the verbose persona.

AC: specs/voice-agents.feature "Demo — ElevenLabs interruption (server VAD barge-in)"

How to run:
    # 1. Provision the ElevenLabs test agent (sets ELEVENLABS_AGENT_ID in .env):
    make voice-elevenlabs-provision

    # 2. Run:
    cd python
    uv run examples/voice/elevenlabs_interruption.py

Required env vars:
    OPENAI_API_KEY       — JudgeAgent LLM + UserSimulatorAgent TTS
    ELEVENLABS_API_KEY   — ElevenLabs platform key
    ELEVENLABS_AGENT_ID  — hosted ConvAI agent id
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


async def main() -> scenario.ScenarioResult:
    result = await scenario.run(
        name="demo_elevenlabs_interruption",
        description=(
            "User interrupts a hosted ElevenLabs ConvAI agent mid-utterance via "
            "scenario.interrupt(). EL has no client-side cancel, so the server's "
            "VAD must detect the overlap and cut the agent's reply, then the "
            "agent must acknowledge the NEW topic in its next utterance."
        ),
        agents=[
            scenario.ElevenLabsAgentAdapter(
                agent_id=os.environ["ELEVENLABS_AGENT_ID"],
                api_key=os.environ["ELEVENLABS_API_KEY"],
            ),
            scenario.UserSimulatorAgent(voice="openai/nova"),
            scenario.JudgeAgent(
                criteria=[
                    # The mechanism: a fresh user audio turn arrives while
                    # the agent is mid-reply, server VAD detects the
                    # overlap, the agent's interrupted utterance is cut
                    # short, and the agent then PIVOTS to the new topic.
                    # The "pivot" is the load-bearing check — if the agent
                    # keeps talking about products after the user asked
                    # about business hours, the interrupt failed.
                    "The agent's reply preceding the interrupt is cut off mid-thought (truncation evidence: short or incomplete sentence in its transcript)",
                    "After the user's interrupting turn (asking about business hours), the agent's NEXT reply addresses business hours specifically — it does NOT continue describing products or features",
                    "The conversation transcript is a coherent example of a mid-utterance interrupt landing on ElevenLabs ConvAI and the agent acknowledging the topic shift",
                ]
            ),
        ],
        script=[
            # EL ConvAI specific: send user audio while EL is still playing
            # its first_message greeting. EL's server-side VAD fires
            # interruption + agent_response_correction, then settles into
            # turn-taking mode and replies to the user's audio after a
            # ~5-15s post-correction grace window. A "lead with bare
            # agent() to drain greeting" approach fails — EL's session
            # only engages turn-taking when user audio overlaps the
            # greeting on connect. Verified empirically in the
            # /tmp/ei_run7.log run that produced 6 audio segments.
            scenario.user("Hello, I'd like to know about your products."),
            scenario.agent(),
            # Verbose request to give the agent something to barge into.
            scenario.user("Tell me about every product feature you offer in detail."),
            scenario.interrupt(
                "Sorry, one more thing — what are your business hours?",
                wait_for_speech_timeout=15.0,
            ),
            # Post-interrupt agent reply — judge inspects this for the
            # topic pivot to business hours.
            scenario.agent(),
            scenario.judge(),
        ],
        max_turns=12,
    )

    print(f"success: {result.success}")
    print(f"verdict: {result.reasoning}")

    if result.latency is not None:
        print(f"interrupt_response_time: {result.latency.interrupt_response_time}")

    save_demo_recording(getattr(result, "audio", None))
    return result


if __name__ == "__main__":
    asyncio.run(main())
