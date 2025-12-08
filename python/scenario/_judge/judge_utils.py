"""
Utilities for the Judge agent.
"""

import json
import re
from typing import Any, Dict, List

from openai.types.chat import ChatCompletionMessageParam

from .deep_transform import deep_transform


def _truncate_base64_media(value: Any) -> Any:
    """
    Truncates base64 media data to reduce token usage.

    Handles:
    - Data URLs: `data:image/png;base64,...`
    - AI SDK file parts: `{ type: "file", mediaType: "audio/wav", data: "<base64>" }`
    - Raw base64 strings over threshold (likely binary data)
    """

    def transform_fn(v: Any) -> Any:
        if isinstance(v, str):
            # Handle data URLs
            match = re.match(
                r"^data:((image|audio|video)/[a-z0-9+.-]+);base64,(.+)$",
                v,
                re.IGNORECASE,
            )
            if match:
                mime_type = match.group(1)
                media_type = match.group(2).upper()
                size = len(match.group(3))
                return f"[{media_type}: {mime_type}, ~{size} bytes]"
            return v

        if isinstance(v, dict):
            obj = v

            # Handle AI SDK file parts: {type: "file", mediaType: "...", data: "<base64>"}
            if (
                obj.get("type") == "file"
                and isinstance(obj.get("mediaType"), str)
                and isinstance(obj.get("data"), str)
            ):
                media_type = obj["mediaType"]
                category = (
                    media_type.split("/")[0].upper() if "/" in media_type else "FILE"
                )
                return {
                    **obj,
                    "data": f"[{category}: {media_type}, ~{len(obj['data'])} bytes]",
                }

            # Handle image parts with raw base64: {type: "image", image: "<base64>"}
            if obj.get("type") == "image" and isinstance(obj.get("image"), str):
                image_data = obj["image"]

                # Check if it's a data URL or raw base64
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
                if len(image_data) > 1000 and re.match(
                    r"^[A-Za-z0-9+/=]+$", image_data
                ):
                    return {
                        **obj,
                        "image": f"[IMAGE: unknown, ~{len(image_data)} bytes]",
                    }

        return v

    return deep_transform(value, transform_fn)


class JudgeUtils:
    """Utilities for the Judge agent."""

    @staticmethod
    def build_transcript_from_messages(
        messages: List[ChatCompletionMessageParam],
    ) -> str:
        """
        Builds a minimal transcript from messages for judge evaluation.

        Truncates base64 media to reduce token usage.

        Args:
            messages: Array of ChatCompletionMessageParam from conversation

        Returns:
            Plain text transcript with one message per line
        """
        lines = []
        for msg in messages:
            role = msg.get("role", "unknown")
            content = msg.get("content", "")
            truncated_content = _truncate_base64_media(content)
            lines.append(f"{role}: {json.dumps(truncated_content)}")
        return "\n".join(lines)
