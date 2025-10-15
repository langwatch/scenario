"""
Multimodal Audio to Text Tests

This test suite demonstrates how to test an agent that:
- Receives audio input (from a WAV file fixture)
- Processes the audio content
- Responds with text output

This is perfect for transcription services, audio Q&A systems,
or any agent that needs to analyze voice input and provide text responses.
"""

import os
from typing import ClassVar, Literal, Sequence, TypedDict, cast
import pytest
import scenario
from scenario.types import AgentInput, AgentReturnTypes, AgentRole
from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam
from helpers import encode_audio_to_base64, wrap_judge_for_audio


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


class AudioToTextAgent(scenario.AgentAdapter):
    """
    Agent that accepts audio input and responds with text

    Uses OpenAI's gpt-4o-audio-preview model which can:
    - Process audio input
    - Generate text transcripts
    - Respond with text-only messages
    """

    role: ClassVar[AgentRole] = AgentRole.AGENT

    def __init__(self):
        super().__init__()
        self.client = AsyncOpenAI()

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        """
        Process audio input and return text response

        Converts scenario messages to OpenAI format, calls the audio model,
        and returns only the text transcript (not audio).
        """
        messages = self._convert_messages_to_openai_format(input.messages)
        response = await self._respond(messages)

        # Extract and return only the text transcript
        transcript = (
            response.choices[0].message.audio.transcript
            if response.choices[0].message.audio
            else None
        )

        if isinstance(transcript, str):
            return transcript
        else:
            raise Exception("Agent failed to generate a response")

    def _convert_messages_to_openai_format(
        self, messages: Sequence[ChatCompletionMessageParam | MultimodalMessage]
    ) -> list[ChatCompletionMessageParam]:
        """
        Convert scenario messages to OpenAI chat completion format

        Handles multimodal messages with audio file parts by converting them
        to OpenAI's input_audio format.
        """
        converted = []
        for msg in messages:
            if isinstance(msg, dict):
                role = msg.get("role")
                content = msg.get("content")

                if isinstance(content, list):
                    # Check for audio file parts
                    has_audio = any(
                        isinstance(part, dict)
                        and part.get("type") == "file"
                        and part.get("mediaType", "").startswith("audio/")
                        for part in content
                    )

                    if has_audio:
                        # Extract text and audio components
                        text_content = ""
                        audio_data = None

                        for part in content:
                            if isinstance(part, dict):
                                if part.get("type") == "text":
                                    text_content = part.get("text", "")
                                elif part.get("type") == "file" and part.get(
                                    "mediaType", ""
                                ).startswith("audio/"):
                                    audio_data = part.get("data")

                        if audio_data:
                            converted.append(
                                {
                                    "role": role,
                                    "content": [
                                        {"type": "text", "text": text_content},
                                        {
                                            "type": "input_audio",
                                            "input_audio": {
                                                "data": audio_data,
                                                "format": "wav",
                                            },
                                        },
                                    ],
                                }
                            )
                            continue

                # Regular text message
                converted.append(
                    {
                        "role": role,
                        "content": content if isinstance(content, str) else "",
                    }
                )

        return converted  # type: ignore[return-value]

    async def _respond(self, messages: list[ChatCompletionMessageParam]):
        """
        Call OpenAI's audio model to process audio and generate text response
        """
        return await self.client.chat.completions.create(
            model="gpt-4o-audio-preview",
            modalities=["text", "audio"],
            audio={"voice": "alloy", "format": "wav"},
            messages=messages,
            store=False,
        )


# Use setId to group together for visualizing in the UI
SET_ID = "multimodal-audio-to-text-test"


@pytest.mark.asyncio
async def test_audio_to_text():
    """
    Test agent that receives audio input and responds with text

    This test:
    1. Loads an audio fixture with a spoken question
    2. Sends the audio to the agent
    3. Agent analyzes the audio and responds with text
    4. Judge evaluates the text response
    """
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
                "text": """
                Answer the question in the audio.
                If you're not sure, you're required to take a best guess.
                After you've guessed, you must repeat the question and say what format the input was in (audio or text)
                """,
            },
            {
                "type": "file",
                "mediaType": "audio/wav",
                "data": audio_data,
            },
        ],
    }

    # Create judge agent to evaluate the response
    # Wrap with audio handler in case the judge needs to process audio
    audio_judge = wrap_judge_for_audio(
        scenario.JudgeAgent(
            model="openai/gpt-4o",
            criteria=[
                "The agent correctly guesses it's a male voice",
                "The agent repeats the question",
                "The agent says what format the input was in (audio or text)",
            ],
        )
    )

    # Run the scenario
    result = await scenario.run(
        name="multimodal audio to text",
        description="User sends audio file, agent analyzes and responds with text",
        agents=[
            AudioToTextAgent(),
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
        print("AUDIO TO TEXT RESULT:", result)
        assert result.success
    except Exception as error:
        print("Audio to text test failed:", result)
        raise error
