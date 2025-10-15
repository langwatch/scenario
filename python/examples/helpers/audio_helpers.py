"""
Audio Conversation Utilities

This module provides utilities for extracting, processing, and saving audio data
from scenario test conversations. It enables you to:
- Extract audio segments from multi-turn conversations
- Concatenate multiple audio segments into a single file
- Save full conversations as playable audio files for review

Useful for debugging audio-based agent interactions and creating conversation recordings.
"""

import base64
import os
from typing import Any, List


def encode_audio_to_base64(file_path: str) -> str:
    """
    Encode audio file to base64 string for transmission in messages

    Args:
        file_path: Path to the audio file (WAV, MP3, etc.)

    Returns:
        Base64-encoded string representation of the audio file
    """
    with open(file_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


async def save_conversation_audio(result: Any, output_path: str) -> None:
    """
    Extract audio from scenario messages and save as concatenated audio file

    This function:
    1. Scans all messages for audio content
    2. Extracts and decodes base64 audio data
    3. Concatenates all segments in conversation order
    4. Saves the result as a single WAV file

    Args:
        result: Scenario result containing conversation messages
        output_path: Path where the concatenated audio file should be saved
    """
    audio_segments = []

    # Extract audio data from all messages
    for index, message in enumerate(result.messages):
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict):
                        if part.get("type") == "file" and part.get(
                            "mediaType", ""
                        ).startswith("audio/"):
                            speaker = (
                                "User" if message.get("role") == "user" else "Agent"
                            )
                            audio_segments.append(
                                {
                                    "data": part.get("data"),
                                    "speaker": speaker,
                                    "timestamp": index,
                                }
                            )

    if not audio_segments:
        print("No audio data found in conversation")
        return

    print(f"Found {len(audio_segments)} audio segments")

    # Create output directory if needed
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    # Create temp directory for segments
    temp_dir = os.path.join(os.getcwd(), "temp_audio")
    os.makedirs(temp_dir, exist_ok=True)

    segment_files = []

    # Save each segment
    for i, segment in enumerate(audio_segments):
        segment_path = os.path.join(
            temp_dir, f"segment_{i}_{segment['speaker'].lower()}.wav"
        )

        audio_buffer = base64.b64decode(segment["data"])
        with open(segment_path, "wb") as f:
            f.write(audio_buffer)

        segment_files.append(segment_path)
        print(f"Saved {segment['speaker']} segment {i + 1} to {segment_path}")

    # Concatenate WAV files
    await concatenate_wav_files(segment_files, output_path)

    # Clean up temp files
    for file in segment_files:
        try:
            os.unlink(file)
        except Exception as error:
            print(f"Failed to delete temporary file {file}:", error)

    # Clean up temp directory
    try:
        os.rmdir(temp_dir)
    except:
        pass

    print(f"📻 Full conversation saved to: {output_path}")


async def concatenate_wav_files(input_files: List[str], output_file: str) -> None:
    """
    Concatenate multiple WAV files into a single output file

    This is a basic implementation that:
    - Reuses the header from the first file
    - Strips headers from subsequent files
    - Concatenates all audio data
    - Updates the header with the new total size

    WARNING: This works for basic WAV files with identical format parameters.
    For production use or files with different formats, consider using ffmpeg.

    Args:
        input_files: List of WAV file paths to concatenate
        output_file: Output file path for concatenated audio
    """
    if not input_files:
        raise ValueError("No input files provided")

    if len(input_files) == 1:
        # Single file, just copy it
        with open(input_files[0], "rb") as src:
            with open(output_file, "wb") as dst:
                dst.write(src.read())
        return

    # Read first file to get header
    with open(input_files[0], "rb") as f:
        first_file = f.read()

    wav_header = first_file[:44]  # Standard WAV header is 44 bytes

    # Collect all audio data
    audio_data_segments = []
    total_data_size = 0

    for file in input_files:
        with open(file, "rb") as f:
            file_buffer = f.read()

        audio_data = file_buffer[44:]  # Skip the 44-byte WAV header
        audio_data_segments.append(audio_data)
        total_data_size += len(audio_data)

    # Create new header with updated size
    new_header = bytearray(wav_header)

    # Update RIFF chunk size at offset 4
    new_chunk_size = total_data_size + 36
    new_header[4:8] = new_chunk_size.to_bytes(4, byteorder="little")

    # Update data chunk size at offset 40
    new_header[40:44] = total_data_size.to_bytes(4, byteorder="little")

    # Write concatenated file
    with open(output_file, "wb") as f:
        f.write(new_header)
        for segment in audio_data_segments:
            f.write(segment)
