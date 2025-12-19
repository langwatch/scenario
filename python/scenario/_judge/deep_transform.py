"""
Recursive value transformation utility.
"""

from typing import Any, Callable, Dict, List


def deep_transform(value: Any, fn: Callable[[Any], Any]) -> Any:
    """
    Recursively transforms values in a structure.

    If callback returns a different value, uses it and stops recursion for that branch.
    Otherwise recurses into lists/dicts.

    Args:
        value: The value to transform
        fn: Transformation function applied to each value

    Returns:
        Transformed value
    """
    result = fn(value)
    if result is not value:
        return result

    if isinstance(value, list):
        return [deep_transform(v, fn) for v in value]

    if isinstance(value, dict):
        return {k: deep_transform(v, fn) for k, v in value.items()}

    return value
