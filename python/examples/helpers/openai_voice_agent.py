"""
OpenAI Voice Agent - Base class for voice-to-voice AI agents

This module provides a base class for creating agents that can:
- Accept audio input (voice messages from users)
- Generate audio output (voice responses)
- Handle multi-turn voice conversations

Uses OpenAI's gpt-4o-audio-preview model which supports voice-to-voice interaction.
"""

from typing import Any, List, Optional
from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam
import scenario
from scenario.types import AgentInput, AgentReturnTypes, AgentRole


class OpenAiVoiceAgent(scenario.AgentAdapter):
    """
    Base class for voice-enabled agents using OpenAI's voice-to-voice model

    This class handles:
    - Converting messages to OpenAI format
    - Calling the OpenAI audio API
    - Processing audio responses
    - Creating properly formatted audio messages

    Subclasses must define the `role` property (AGENT or USER)
    """

    def __init__(
        self,
        system_prompt: Optional[str] = None,
        voice: str = "alloy",
        force_user_role: bool = False,
    ):
        """
        Initialize voice agent

        Args:
            system_prompt: System prompt to guide the agent's behavior
            voice: OpenAI voice to use (alloy, nova, echo, fable, onyx, shimmer)
            force_user_role: Force response to use "user" role instead of "assistant"
        """
        super().__init__()
        self.system_prompt = system_prompt
        self.voice = voice
        self.force_user_role = force_user_role
        self.client = AsyncOpenAI()

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        """
        Main entry point - processes input and generates audio response

        Args:
            input: Agent input containing conversation messages

        Returns:
            Audio message or text fallback
        """
        try:
            messages = self._convert_messages(input.messages)
            response = await self._respond_with_audio(messages)
            return self._handle_response(response)
        except Exception as error:
            print(f"{self.__class__.__name__} failed to generate a response", error)
            raise error

    def _convert_messages(
        self, messages: List[Any]
    ) -> List[ChatCompletionMessageParam]:
        """Convert scenario messages to OpenAI format

        Note: OpenAI only accepts audio in 'user' role messages, not 'assistant'.
        So we force all audio messages to have role='user'.
        """
        converted = []
        for msg in messages:
            if isinstance(msg, dict):
                role = msg.get("role")
                content = msg.get("content")

                if isinstance(content, list) and len(content) > 1:
                    # Check if this is an audio message (has file part)
                    has_audio = False
                    for part in content:
                        if (
                            isinstance(part, dict)
                            and part.get("type") == "file"
                            and part.get("mediaType", "").startswith("audio/")
                        ):
                            has_audio = True
                            break

                    if has_audio:
                        # Extract text and audio parts
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

                        # Force role to "user" for audio messages (OpenAI requirement)
                        if audio_data:
                            converted.append(
                                {
                                    "role": "user",
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

                # Regular message (no audio or simple content)
                converted.append(
                    {
                        "role": role,
                        "content": content if isinstance(content, str) else "",
                    }
                )

        return converted  # type: ignore[return-value]

    async def _respond_with_audio(
        self, messages: List[ChatCompletionMessageParam]
    ) -> Any:
        """
        Call OpenAI's audio-enabled model to generate voice response

        Uses gpt-4o-audio-preview with:
        - Text and audio modalities
        - WAV format output
        - Configured voice
        - Optional system prompt
        """
        final_messages = messages
        if self.system_prompt:
            final_messages = [
                {"role": "system", "content": self.system_prompt},
                *messages,
            ]

        return await self.client.chat.completions.create(
            model="gpt-4o-audio-preview",
            modalities=["text", "audio"],
            audio={"voice": self.voice, "format": "wav"},
            messages=final_messages,
            store=False,
        )

    def _handle_response(self, response: Any) -> AgentReturnTypes:
        """
        Process OpenAI API response and extract audio or text

        Priority order:
        1. Audio data - creates audio message with base64 WAV data
        2. Text transcript - returns as plain text fallback
        3. Neither - throws error
        """
        audio_data = (
            response.choices[0].message.audio.data
            if response.choices[0].message.audio
            else None
        )
        transcript = (
            response.choices[0].message.audio.transcript
            if response.choices[0].message.audio
            else None
        )

        if audio_data:
            print(f"\n{self.__class__.__name__} AUDIO RESPONSE\n", transcript)
            return self._create_audio_message(audio_data)
        elif transcript:
            print(f"\n{self.__class__.__name__} TEXT FALLBACK\n", transcript)
            return transcript
        else:
            raise Exception(f"{self.__class__.__name__} failed to generate a response")

    def _create_audio_message(self, audio_data: str) -> ChatCompletionMessageParam:
        """
        Create a properly formatted audio message for the conversation

        The message includes:
        - Empty text part (required structure)
        - File part with base64 WAV data
        - Correct role (user or assistant) based on agent configuration
        """
        role = (
            "user"
            if self.role == AgentRole.USER or self.force_user_role
            else "assistant"
        )

        return {  # type: ignore[return-value]  # Custom audio message format with 'file' type extends standard OpenAI message structure
            "role": role,
            "content": [
                {"type": "text", "text": ""},
                {"type": "file", "mediaType": "audio/wav", "data": audio_data},
            ],
        }
