"""Tests for judge utility modules."""

from typing import Any, cast

import pytest

from scenario._judge.deep_transform import deep_transform
from scenario._judge.judge_utils import JudgeUtils
from scenario._judge.string_deduplicator import StringDeduplicator
from scenario._judge.truncate_media import truncate_media_part, truncate_media_url


class TestDeepTransform:
    """Tests for deep_transform function."""

    def test_transforms_simple_value(self) -> None:
        """Should transform a simple value."""
        result = deep_transform(
            "hello", lambda v: v.upper() if isinstance(v, str) else v
        )
        assert result == "HELLO"

    def test_transforms_list_elements(self) -> None:
        """Should recursively transform list elements."""
        result = deep_transform(
            ["a", "b", "c"],
            lambda v: v.upper() if isinstance(v, str) else v,
        )
        assert result == ["A", "B", "C"]

    def test_transforms_dict_values(self) -> None:
        """Should recursively transform dict values."""
        result = deep_transform(
            {"key": "value"},
            lambda v: v.upper() if isinstance(v, str) else v,
        )
        assert result == {"key": "VALUE"}

    def test_stops_recursion_when_fn_returns_different_value(self) -> None:
        """Should stop recursion when fn returns a different value."""
        result = deep_transform(
            {"nested": {"deep": "value"}},
            lambda v: "REPLACED" if isinstance(v, dict) and "deep" in v else v,
        )
        assert result == {"nested": "REPLACED"}

    def test_handles_nested_structures(self) -> None:
        """Should handle deeply nested structures."""
        data = {"level1": {"level2": [{"level3": "value"}]}}
        result = deep_transform(
            data,
            lambda v: v.upper() if isinstance(v, str) else v,
        )
        assert result == {"level1": {"level2": [{"level3": "VALUE"}]}}


class TestStringDeduplicator:
    """Tests for StringDeduplicator class."""

    def test_returns_original_for_first_occurrence(self) -> None:
        """Should return original string on first occurrence."""
        dedup = StringDeduplicator(threshold=10)
        result = dedup.process("This is a long string for testing")
        assert result == "This is a long string for testing"

    def test_returns_marker_for_duplicate(self) -> None:
        """Should return marker for duplicate strings."""
        dedup = StringDeduplicator(threshold=10)
        original = "This is a long string for testing"
        dedup.process(original)
        result = dedup.process(original)
        assert result == "[DUPLICATE - SEE ABOVE]"

    def test_ignores_strings_below_threshold(self) -> None:
        """Should not deduplicate strings below threshold."""
        dedup = StringDeduplicator(threshold=50)
        short = "Short"
        assert dedup.process(short) == "Short"
        assert dedup.process(short) == "Short"  # Not marked as duplicate

    def test_normalizes_whitespace_for_comparison(self) -> None:
        """Should treat strings with different whitespace as duplicates."""
        dedup = StringDeduplicator(threshold=10)
        dedup.process("Line one\nLine two\nLine three")
        result = dedup.process("Line one\n\nLine two\n  Line three")
        assert result == "[DUPLICATE - SEE ABOVE]"

    def test_reset_clears_seen_strings(self) -> None:
        """Should clear seen strings on reset."""
        dedup = StringDeduplicator(threshold=10)
        original = "This is a long string for testing"
        dedup.process(original)
        dedup.reset()
        result = dedup.process(original)
        assert result == original  # Not marked as duplicate


class TestTruncateMediaUrl:
    """Tests for truncate_media_url function."""

    def test_truncates_image_data_url(self) -> None:
        """Should truncate image data URLs."""
        data_url = "data:image/png;base64," + "A" * 1000
        result = truncate_media_url(data_url)
        assert result == "[IMAGE: image/png, ~1000 bytes]"

    def test_truncates_audio_data_url(self) -> None:
        """Should truncate audio data URLs."""
        data_url = "data:audio/wav;base64," + "B" * 500
        result = truncate_media_url(data_url)
        assert result == "[AUDIO: audio/wav, ~500 bytes]"

    def test_truncates_video_data_url(self) -> None:
        """Should truncate video data URLs."""
        data_url = "data:video/mp4;base64," + "C" * 2000
        result = truncate_media_url(data_url)
        assert result == "[VIDEO: video/mp4, ~2000 bytes]"

    def test_returns_non_data_url_unchanged(self) -> None:
        """Should return non-data URLs unchanged."""
        url = "https://example.com/image.png"
        result = truncate_media_url(url)
        assert result == url

    def test_returns_regular_string_unchanged(self) -> None:
        """Should return regular strings unchanged."""
        text = "Hello, world!"
        result = truncate_media_url(text)
        assert result == text


class TestTruncateMediaPart:
    """Tests for truncate_media_part function."""

    def test_truncates_file_part(self) -> None:
        """Should truncate AI SDK file parts."""
        part = {
            "type": "file",
            "mediaType": "audio/wav",
            "data": "A" * 1000,
        }
        result = truncate_media_part(part)
        assert result is not None
        assert result["type"] == "file"
        assert result["mediaType"] == "audio/wav"
        assert result["data"] == "[AUDIO: audio/wav, ~1000 bytes]"

    def test_truncates_image_part_with_data_url(self) -> None:
        """Should truncate AI SDK image parts with data URLs."""
        part = {
            "type": "image",
            "image": "data:image/png;base64," + "B" * 500,
        }
        result = truncate_media_part(part)
        assert result is not None
        assert result["image"] == "[IMAGE: image/png, ~500 bytes]"

    def test_truncates_image_part_with_raw_base64(self) -> None:
        """Should truncate AI SDK image parts with raw base64."""
        part = {
            "type": "image",
            "image": "A" * 2000,  # Long base64-like string
        }
        result = truncate_media_part(part)
        assert result is not None
        assert "[IMAGE: unknown" in result["image"]

    def test_returns_none_for_non_media_dict(self) -> None:
        """Should return None for non-media dicts."""
        part = {"type": "text", "content": "Hello"}
        result = truncate_media_part(part)
        assert result is None

    def test_returns_none_for_non_dict(self) -> None:
        """Should return None for non-dict values."""
        assert truncate_media_part("string") is None
        assert truncate_media_part(123) is None
        assert truncate_media_part(None) is None
        assert truncate_media_part([1, 2, 3]) is None


class TestJudgeUtils:
    """Tests for JudgeUtils class."""

    def test_build_transcript_basic(self) -> None:
        """Should build transcript from messages."""
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]
        result = JudgeUtils.build_transcript_from_messages(cast(Any, messages))
        assert 'user: "Hello"' in result
        assert 'assistant: "Hi there!"' in result

    def test_build_transcript_truncates_media(self) -> None:
        """Should truncate base64 media in transcript."""
        messages = [
            {
                "role": "user",
                "content": "data:image/png;base64," + "A" * 1000,
            },
        ]
        result = JudgeUtils.build_transcript_from_messages(cast(Any, messages))
        assert "[IMAGE: image/png" in result
        assert "A" * 100 not in result  # Base64 should be truncated

    def test_build_transcript_handles_empty_messages(self) -> None:
        """Should handle empty message list."""
        result = JudgeUtils.build_transcript_from_messages([])
        assert result == ""

    def test_build_transcript_handles_complex_content(self) -> None:
        """Should handle complex message content."""
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe this image"},
                    {"type": "image", "image": "data:image/png;base64," + "B" * 500},
                ],
            },
        ]
        result = JudgeUtils.build_transcript_from_messages(cast(Any, messages))
        assert "Describe this image" in result
        assert "[IMAGE:" in result
