"""
Media truncation utilities for reducing token usage.
"""

import re
from typing import Any, Dict, Optional


def truncate_media_url(s: str) -> str:
    """
    Truncates base64 data URLs to human-readable markers.

    Args:
        s: String to check

    Returns:
        Marker if data URL, original string otherwise
    """
    match = re.match(
        r"^data:((image|audio|video)/[a-z0-9+.-]+);base64,(.+)$",
        s,
        re.IGNORECASE,
    )
    if not match:
        return s

    mime_type = match.group(1)
    category = match.group(2).upper()
    data = match.group(3)
    return f"[{category}: {mime_type}, ~{len(data)} bytes]"


def truncate_media_part(v: Any) -> Optional[Dict[str, Any]]:
    """
    Truncates AI SDK file/image parts by replacing base64 data with markers.

    Args:
        v: Value to check

    Returns:
        Truncated object if media part, None otherwise
    """
    if v is None or not isinstance(v, dict):
        return None

    obj = v

    # AI SDK file parts: {type: "file", mediaType: "...", data: "..."}
    if (
        obj.get("type") == "file"
        and isinstance(obj.get("mediaType"), str)
        and isinstance(obj.get("data"), str)
    ):
        media_type = obj["mediaType"]
        category = media_type.split("/")[0].upper() if "/" in media_type else "FILE"
        return {
            **obj,
            "data": f"[{category}: {media_type}, ~{len(obj['data'])} bytes]",
        }

    # AI SDK image parts: {type: "image", image: "..."}
    if obj.get("type") == "image" and isinstance(obj.get("image"), str):
        image_data = obj["image"]

        # Data URL format
        data_url_match = re.match(
            r"^data:((image)/[a-z0-9+.-]+);base64,(.+)$",
            image_data,
            re.IGNORECASE,
        )
        if data_url_match:
            return {
                **obj,
                "image": f"[IMAGE: {data_url_match.group(1)}, ~{len(data_url_match.group(3))} bytes]",
            }

        # Raw base64 (long string without common text patterns)
        if len(image_data) > 1000 and re.match(r"^[A-Za-z0-9+/=]+$", image_data):
            return {
                **obj,
                "image": f"[IMAGE: unknown, ~{len(image_data)} bytes]",
            }

    return None
