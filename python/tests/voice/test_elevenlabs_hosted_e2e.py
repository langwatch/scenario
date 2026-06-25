"""
E2E wrapper for Demo — ElevenLabs hosted Conversational AI.

AC (#705 parity with the TS twin): the WS reaches
wss://api.elevenlabs.io/v1/convai/conversation and a MULTI-TURN real-voice run
completes where turns 2+ reached EL's STT — i.e. every scripted user turn was
committed as REAL PCM (audio_commit_count >= 2), NONE was text-injected
(text_commit_count == 0), and EL returned a non-empty STT user_transcript. This
voice-specific assertion is strictly stronger than #596's `>=N segments`, which
passes even on the broken text-commit path.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "examples" / "voice"))


@pytest.mark.asyncio
async def test_demo_elevenlabs_hosted_e2e_success(requires_llm, requires_elevenlabs_hosted_agent):
    """Hosted EL agent sustains REAL voice-in across turns 2+ and succeeds."""
    from elevenlabs_hosted import main  # type: ignore[import]

    result, agent = await main()

    # Voice-specific, STT-driven assertion (issue #705 / AC4): real audio reached
    # the agent on turns 2+ …
    assert agent.audio_commit_count >= 2, (
        f"expected >=2 real-audio user commits (turns 2+ as PCM), "
        f"got {agent.audio_commit_count}"
    )
    # … and no turn was text-committed (which would bypass STT / re-introduce #705) …
    assert agent.text_commit_count == 0, (
        f"a user turn was text-committed — audio bypassed STT (the #705 bug); "
        f"text_commit_count={agent.text_commit_count}"
    )
    # … and EL produced an STT transcript, proving the audio was processed.
    assert agent.last_user_transcript, "no STT user_transcript — audio did not reach the agent"

    # The judge verdict is the softer, holistic check.
    assert result.success, f"Expected success; verdict: {result.reasoning}"
