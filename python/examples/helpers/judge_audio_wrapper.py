"""
Judge Agent Audio Wrapper

Wraps a judge agent to automatically transcribe audio messages to text
before evaluation. Required because judge agents can't process audio directly.
"""

import base64
from typing import Any, List
from openai import AsyncOpenAI
import scenario
from scenario.types import AgentInput, AgentReturnTypes


def wrap_judge_for_audio(judge: scenario.AgentAdapter) -> scenario.AgentAdapter:
    """
    Wrap a judge agent to handle audio content in messages
    
    The wrapper:
    - Intercepts the judge's call method
    - Transcribes any audio content to text using Whisper
    - Passes sanitized text-only messages to the judge
    
    Args:
        judge: The judge agent to wrap
        
    Returns:
        The same judge instance with wrapped call method
    """
    original_call = judge.call
    
    async def wrapped_call(input: AgentInput) -> AgentReturnTypes:
        sanitized_messages = await sanitize_messages_for_audio(input.messages)
        return await original_call(
            scenario.AgentInput(
                thread_id=input.thread_id,
                messages=sanitized_messages,
                new_messages=input.new_messages,
                judgment_request=input.judgment_request,
                scenario_state=input.scenario_state
            )
        )
    
    judge.call = wrapped_call  # type: ignore[method-assign]
    return judge


async def sanitize_messages_for_audio(messages: List[Any]) -> List[Any]:
    """
    Convert audio parts in messages to text transcriptions
    
    Process:
    1. Scans all message content for audio file parts
    2. Transcribes audio using OpenAI Whisper (with caching)
    3. Replaces audio parts with transcribed text
    4. Returns sanitized messages
    
    Args:
        messages: List of messages potentially containing audio
        
    Returns:
        List of messages with audio converted to text transcriptions
    """
    cache: dict[str, str] = {}
    sanitized = []
    
    for message in messages:
        if not isinstance(message, dict):
            sanitized.append(message)
            continue
        
        if message.get("role") == "tool":
            sanitized.append(message)
            continue
        
        content = message.get("content")
        if isinstance(content, list):
            text_parts = []
            for part in content:
                if isinstance(part, dict):
                    if part.get("type") == "text":
                        text_parts.append(part.get("text", ""))
                    elif part.get("type") == "file" and part.get("mediaType", "").startswith("audio/"):
                        audio_data = part.get("data", "")
                        if audio_data in cache:
                            text_parts.append(cache[audio_data])
                        else:
                            transcription = await transcribe_audio(audio_data)
                            cache[audio_data] = transcription
                            text_parts.append(transcription)
            
            text_content = " ".join(filter(None, text_parts))
            sanitized.append({
                **message,
                "content": text_content or "[Audio message]"
            })
        else:
            sanitized.append(message)
    
    return sanitized


async def transcribe_audio(audio_data: str) -> str:
    """
    Transcribe audio data to text using OpenAI Whisper
    
    Args:
        audio_data: Base64-encoded audio data
        
    Returns:
        Transcribed text, or error placeholder if transcription fails
    """
    try:
        client = AsyncOpenAI()
        audio_bytes = base64.b64decode(audio_data)
        
        # Create a file-like object for the Whisper API
        response = await client.audio.transcriptions.create(
            model="whisper-1",
            file=("audio.wav", audio_bytes, "audio/wav"),
            language="en"
        )
        
        return response.text
    except Exception as error:
        print("Error transcribing audio", error)
        return "[Audio: transcription failed]"

