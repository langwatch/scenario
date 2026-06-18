"""
Audio Encoding Utilities

This module provides a utility for encoding audio files for transmission in
scenario test conversation messages.

Used by the audio-to-audio and audio-to-text examples to embed fixture audio
as base64-encoded message content.
"""

import base64


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
