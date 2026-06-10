"""
Tests that print_openai_messages renders audio content cleanly.

Covers specs/voice-agents.feature "Audio messages render cleanly in the terminal".

Without this guarantee the terminal fills with base64-encoded WAV data on every
voice turn, which buries the actual scenario flow in noise.
"""

from __future__ import annotations

import re

from scenario.voice import AudioChunk, create_audio_message
from scenario._utils.utils import print_openai_messages, _format_message_content


_BASE64_RUN = re.compile(r"[A-Za-z0-9+/]{40,}={0,2}")


def _voice_chunk(transcript: str | None = "hello world") -> AudioChunk:
    return AudioChunk(data=b"\x00\x00" * 2400, transcript=transcript)


_SPEAKER_ICON = "\U0001f50a"


def test_audio_with_transcript_renders_as_speaker_icon_plus_italic_text(capsys):
    msg = create_audio_message(_voice_chunk("hello world"), role="assistant")

    print_openai_messages("", [msg])
    out = capsys.readouterr().out

    assert _SPEAKER_ICON in out
    assert "hello world" in out
    assert "\x1b[3m" in out and "\x1b[23m" in out
    assert not _BASE64_RUN.search(out), (
        "raw base64 WAV payload leaked into terminal output"
    )


def test_audio_without_transcript_renders_as_speaker_icon_audio_placeholder(capsys):
    msg = create_audio_message(_voice_chunk(transcript=None), role="user")

    print_openai_messages("", [msg])
    out = capsys.readouterr().out

    assert f"{_SPEAKER_ICON} (audio)" in out
    assert not _BASE64_RUN.search(out)


def test_plain_string_content_is_unchanged():
    assert _format_message_content("just text") == "just text"


def test_text_only_multimodal_content_renders_without_speaker_icon():
    content = [{"type": "text", "text": "just text"}]
    rendered = _format_message_content(content)
    assert rendered == "just text"
    assert _SPEAKER_ICON not in rendered


def test_unknown_part_types_render_as_typed_placeholder():
    content = [{"type": "image_url", "image_url": {"url": "http://x"}}]
    assert _format_message_content(content) == "<image>"
