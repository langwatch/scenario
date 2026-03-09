"""Tests for estimate_tokens module."""

from scenario._judge.estimate_tokens import estimate_tokens, DEFAULT_TOKEN_THRESHOLD


class TestEstimateTokens:
    """Tests for the estimate_tokens function."""

    def test_returns_zero_for_empty_string(self) -> None:
        assert estimate_tokens("") == 0

    def test_returns_approximately_1000_for_4000_ascii_characters(self) -> None:
        text = "a" * 4000
        assert estimate_tokens(text) == 1000

    def test_returns_2_for_8_ascii_characters(self) -> None:
        assert estimate_tokens("abcdefgh") == 2

    def test_rounds_up_for_odd_byte_length(self) -> None:
        # 5 bytes / 4 = 1.25, ceil => 2
        assert estimate_tokens("abcde") == 2

    def test_counts_emojis_as_more_tokens_than_character_count(self) -> None:
        # Each emoji is 4 bytes in UTF-8, so 4 emojis = 16 bytes = 4 tokens
        emojis = "\U0001F600\U0001F601\U0001F602\U0001F603"
        assert estimate_tokens(emojis) == 4

    def test_counts_cjk_characters_as_more_tokens_than_ascii(self) -> None:
        # Each CJK character is 3 bytes in UTF-8: 4 * 3 = 12 bytes / 4 = 3
        cjk = "\u4f60\u597d\u4e16\u754c"  # 你好世界
        assert estimate_tokens(cjk) == 3


class TestDefaultTokenThreshold:
    """Tests for the DEFAULT_TOKEN_THRESHOLD constant."""

    def test_default_threshold_is_8192(self) -> None:
        assert DEFAULT_TOKEN_THRESHOLD == 8192
