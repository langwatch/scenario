"""
Token estimation using a byte-based heuristic.

Uses UTF-8 byte length divided by 4, which accounts for multi-byte characters
(emojis, CJK, etc.) that typically consume more tokens than ASCII text.
"""

import math

DEFAULT_TOKEN_THRESHOLD = 8192
"""
Default token threshold for switching to structure-only trace rendering.
Traces exceeding this estimated token count will be rendered in
structure-only mode with expand/grep tools available to the judge.
"""


def estimate_tokens(text: str) -> int:
    """
    Estimates the number of tokens in a text string using a byte-based heuristic.

    Uses UTF-8 byte length divided by 4, which accounts for multi-byte characters
    (emojis, CJK, etc.) that typically consume more tokens than ASCII text.

    Args:
        text: The text to estimate token count for.

    Returns:
        Estimated token count.
    """
    byte_length = len(text.encode("utf-8"))
    return math.ceil(byte_length / 4)
