"""
Multimodal Voice-to-Voice Conversation Tests

This test suite demonstrates a complete audio-to-audio conversation flow where:
- A user simulator agent generates audio questions
- A main agent responds with audio answers
- Both communicate entirely through voice (no text)
- The conversation is judged for quality
- The full audio is saved for review

This showcases:
- Custom agent implementations with voice capabilities
- Multi-turn voice conversations
- Audio message handling and persistence
- Judge agent integration with audio transcription
- Role reversal for user simulation
"""

import os
from typing import ClassVar
import pytest
import scenario
from scenario.types import AgentInput, AgentReturnTypes, AgentRole
from scenario._utils.utils import reverse_roles
from helpers import OpenAiVoiceAgent, save_conversation_audio, wrap_judge_for_audio

# Skipped in CI: depends on the OpenAI `gpt-4o-audio-preview` model, which
# returns 404 model_not_found as of 2026-05-19. Tracked separately — the
# voice work PR will unskip these tests once model access is restored.
pytestmark = pytest.mark.skipif(
    os.environ.get("CI") == "true",
    reason="Depends on gpt-4o-audio-preview model — unavailable in CI as of 2026-05-19. See issue tracking unskip.",
)


class MyAgent(OpenAiVoiceAgent):
    """
    Main agent that responds with helpful audio answers
    Uses "echo" voice for a distinct sound
    """

    role: ClassVar[AgentRole] = AgentRole.AGENT

    def __init__(self):
        super().__init__(
            system_prompt="""You are a helpful and engaging AI assistant.
            Respond naturally and conversationally since this is an audio conversation.
            Be informative but keep your responses short, concise and engaging.
            Adapt your speaking style to be natural for audio.""",
            voice="echo",
        )


class AudioUserSimulatorAgent(OpenAiVoiceAgent):
    """
    User simulator that generates audio questions

    This agent:
    - Plays the role of a curious user asking questions
    - Generates audio responses (not text)
    - Uses role reversal to properly simulate user behavior
    - Automatically ends conversation after 2 exchanges
    - Uses "nova" voice to differentiate from main agent
    """

    role: ClassVar[AgentRole] = AgentRole.USER

    def __init__(self):
        super().__init__(
            system_prompt="""
            You are role playing as a curious user looking for information about AI agentic testing,
            but you're a total novice and don't know anything about it.

            Be natural and conversational in your speech patterns.
            This is an audio conversation, so speak as you would naturally talk.

            After 2 responses from the other speaker, say "I'm done with this conversation" and say goodbye.

            YOUR LANGUAGE IS ENGLISH.
            """,
            voice="nova",
        )

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        """
        Role reversal is critical here:
        - The agent sees "user" messages as if they're from the assistant
        - This allows the agent to respond AS the user
        - Without this, the conversation flow would be backwards
        """
        messages = reverse_roles(input.messages)
        new_messages = reverse_roles(input.new_messages)
        return await super().call(
            scenario.AgentInput(
                thread_id=input.thread_id,
                messages=messages,
                new_messages=new_messages,
                judgment_request=input.judgment_request,
                scenario_state=input.scenario_state,
            )
        )


# Group related test runs together in the UI
SET_ID = "full-audio-conversation-test"

# Output path for the full conversation audio file
OUTPUT_PATH = os.path.join(
    os.getcwd(), "tmp", "audio_conversations", "full-conversation.wav"
)


@pytest.mark.flaky(reruns=2)
@pytest.mark.asyncio
async def test_voice_to_voice_conversation():
    """
    Complete audio-to-audio conversation test

    This test:
    1. Creates user simulator and agent that communicate via voice
    2. Runs a 2-turn conversation
    3. Saves the full audio for review
    4. Has a judge evaluate the conversation quality
    """
    # Initialize both agents for the conversation
    audio_user_simulator = AudioUserSimulatorAgent()
    audio_agent = MyAgent()

    # Create judge agent to evaluate conversation quality
    # Wrap with audio handler to transcribe audio before judging
    conversation_judge = wrap_judge_for_audio(
        scenario.JudgeAgent(
            model="openai/gpt-4o",
            criteria=["The conversation flows naturally between user and agent"],
        )
    )

    # Execute the full audio conversation scenario
    result = await scenario.run(
        name="full audio-to-audio conversation",
        description="Complete audio conversation between user simulator and agent over multiple turns",
        agents=[audio_agent, audio_user_simulator, conversation_judge],
        script=[
            # Step 1: Run 2 conversation turns between user simulator and agent
            scenario.proceed(2),
            # Step 2: Save the full conversation as a single audio file
            lambda ctx: save_conversation_audio(ctx, OUTPUT_PATH),
            # Step 3: Have judge evaluate the conversation quality
            scenario.judge(),
        ],
        set_id=SET_ID,
    )

    try:
        print("FULL AUDIO CONVERSATION RESULT", result)
        assert result.success
    except Exception as error:
        print("Full audio conversation failed:", result)
        raise error
