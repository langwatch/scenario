"""Custom effect wrapper — users provide an arbitrary bytes -> bytes function."""

from __future__ import annotations

from ._common import EffectFn


def custom(fn: EffectFn) -> EffectFn:
    """Wrap a user-supplied ``fn(audio_bytes) -> audio_bytes``."""
    if not callable(fn):
        raise TypeError("custom() requires a callable that takes and returns bytes")

    def _apply(audio: bytes) -> bytes:
        result = fn(audio)
        if not isinstance(result, (bytes, bytearray)):
            raise TypeError("custom effect function must return bytes")
        return bytes(result)

    return _apply
