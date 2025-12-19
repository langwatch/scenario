"""
String deduplication for reducing token usage in digests.
"""

import re
from typing import Dict


class StringDeduplicator:
    """
    Tracks seen strings and replaces duplicates with markers.

    Only operates on strings; does not handle traversal.
    """

    def __init__(self, *, threshold: int) -> None:
        """
        Args:
            threshold: Minimum string length to consider for deduplication
        """
        self._seen: Dict[str, bool] = {}
        self._threshold = threshold

    def reset(self) -> None:
        """Resets seen strings for a new digest."""
        self._seen.clear()

    def process(self, s: str) -> str:
        """
        Processes a string, returning duplicate marker if seen before.

        Args:
            s: String to process

        Returns:
            Original string or duplicate marker
        """
        if len(s) < self._threshold:
            return s

        key = self._normalize(s)
        if key in self._seen:
            return "[DUPLICATE - SEE ABOVE]"

        self._seen[key] = True
        return s

    def _normalize(self, s: str) -> str:
        """Normalizes string for comparison (whitespace, case)."""
        # JSON-escaped whitespace
        result = re.sub(r"\\[nrt]", " ", s)
        # Actual whitespace
        result = re.sub(r"[\n\r\t]", " ", result)
        # Collapse
        result = re.sub(r"\s+", " ", result)
        return result.strip().lower()
