"""
Multimodal Audio to Audio Tests

This test suite demonstrates how to test an agent that:
- Receives audio input (from a WAV file fixture)
- Processes the audio content
- Responds with audio output

This is perfect for voice assistants, conversational AI, or any agent
that needs to communicate naturally using voice.
"""

import os
from typing import ClassVar, Literal, TypedDict, cast
import pytest
import scenario
from scenario.types import AgentRole
from openai.types.chat import ChatCompletionMessageParam
from helpers import encode_audio_to_base64, wrap_judge_for_audio, OpenAiVoiceAgent

# Skipped in CI: live end-to-end test — calls OpenAI's `gpt-audio-mini` audio
# model and the real LangWatch backend (cost, API keys, non-deterministic
# audio), so it runs live/locally rather than in CI. (The skip historically
# also guarded the now-deleted `gpt-4o-audio-preview`; that model was swapped
# for `gpt-audio-mini`, so the model is no longer the blocker — the skip is
# CI-cost/live-only now.)
pytestmark = pytest.mark.skipif(
    os.environ.get("CI") == "true",
    reason="Live E2E test (real OpenAI gpt-audio-mini + LangWatch backend, cost, non-deterministic audio) — runs live/locally, not in CI.",
)


# Type definitions for multimodal messages with file content
class TextContentPart(TypedDict):
    type: Literal["text"]
    text: str


class FileContentPart(TypedDict):
    type: Literal["file"]
    mediaType: str
    data: str


class MultimodalMessage(TypedDict):
    role: Literal["user", "assistant", "system"]
    content: list[TextContentPart | FileContentPart]


class AudioToAudioAgent(OpenAiVoiceAgent):
    """
    Agent that accepts audio input and responds with audio

    Uses OpenAI's gpt-4o model which can:
    - Process audio input
    - Generate audio responses with voice
    - Maintain conversational context
    """

    role: ClassVar[AgentRole] = AgentRole.AGENT

    def __init__(self):
        super().__init__(
            system_prompt="""You are a helpful assistant that can analyze audio input and respond with audio output.
            You must respond with audio output.
            """,
            voice="alloy",
            force_user_role=True,  # Required for audio responses per OpenAI API
        )


# Use setId to group together for visualizing in the UI
SET_ID = "multimodal-audio-to-audio-test"


@pytest.mark.flaky(reruns=2)
@pytest.mark.asyncio
async def test_audio_to_audio():
    """
    Test agent that receives audio input and responds with audio

    This test:
    1. Loads an audio fixture with a spoken question
    2. Sends the audio to the agent
    3. Agent analyzes the audio and responds with audio
    4. Judge evaluates the audio response (after transcription)
    """
    # Initialize the voice agent
    my_agent = AudioToAudioAgent()

    # Get path to audio fixture
    fixture_path = os.path.join(
        os.path.dirname(__file__), "fixtures", "male_or_female_voice.wav"
    )

    # Encode audio file to base64 for transmission
    audio_data = encode_audio_to_base64(fixture_path)

    # Create multimodal message with text prompt and audio file
    audio_message: MultimodalMessage = {
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": """Answer the question in the audio. If unsure, take your best guess.
                Also mention that you received this as audio input.""",
            },
            {
                "type": "file",
                "mediaType": "audio/wav",
                "data": audio_data,
            },
        ],
    }

    # Create judge agent to evaluate the response
    # Wrap with audio handler to transcribe audio before judging
    audio_judge = wrap_judge_for_audio(
        scenario.JudgeAgent(
            model="openai/gpt-4o",
            criteria=[
                "The agent identifies or guesses the voice is male",
                "The agent acknowledges the input was audio (not text)",
            ],
        )
    )

    # Run the scenario
    result = await scenario.run(
        name="multimodal audio to audio",
        description="User sends audio file, agent analyzes and responds with audio",
        agents=[
            my_agent,
            scenario.UserSimulatorAgent(model="openai/gpt-4o"),
            audio_judge,
        ],
        script=[
            # Cast needed: MultimodalMessage is scenario's extension of ChatCompletionMessageParam
            # that supports file content parts, which are handled internally
            scenario.message(cast(ChatCompletionMessageParam, audio_message)),
            scenario.agent(),
            scenario.judge(),
        ],
        set_id=SET_ID,
    )

    try:
        print("AUDIO TO AUDIO RESULT:", result)
        assert result.success
    except Exception as error:
        print("Audio to audio test failed:", result)
        raise error
