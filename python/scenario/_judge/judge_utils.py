"""
Utilities for the Judge agent.
"""

import json
import re
from typing import Any, Dict, List, Optional

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

            # Handle OpenAI input_audio parts: {type: "input_audio",
            # input_audio: {data: "<base64>", format: "wav"}}. Without this
            # branch, voice scenarios with long replies blow the judge's
            # context window — a 5-second WAV is ~320KB of base64.
            if obj.get("type") in ("input_audio", "audio"):
                audio_obj = obj.get("input_audio") or obj.get("audio") or {}
                if isinstance(audio_obj, dict) and isinstance(audio_obj.get("data"), str):
                    fmt = audio_obj.get("format", "wav")
                    size = len(audio_obj["data"])
                    key = "input_audio" if obj.get("type") == "input_audio" else "audio"
                    return {
                        **obj,
                        key: {
                            **audio_obj,
                            "data": f"[AUDIO: {fmt}, ~{size} bytes]",
                        },
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


def _render_tool_arguments(arguments: Any) -> str:
    """
    Renders a tool call's ``arguments`` for the judge transcript, truncating any
    base64 media nested inside.

    ``arguments`` arrives either as a JSON string (the OpenAI wire shape) or as an
    already-parsed dict. We parse strings so that ``_truncate_base64_media`` can
    reach data-URL values nested in the args, then re-serialize.

    NEVER raises: malformed JSON falls back to defensively truncating the raw
    string. ``build_transcript_from_messages`` runs on every judge call, so an
    exception here would break all judging.
    """
    # Absent arguments: render explicit JSON null. Guarding here keeps the
    # None case from depending on the incidental ``json.dumps(None) == "null"``
    # behaviour of the non-str branch below (which would also funnel None into
    # ``_truncate_base64_media``). Distinct from ``""``/``"{}"``, which are real
    # JSON-string inputs handled by the parse path.
    if arguments is None:
        return "null"

    # Already-parsed dict/list: truncate in place and serialize.
    if not isinstance(arguments, str):
        return json.dumps(_truncate_base64_media(arguments))

    # JSON string: parse so truncation reaches nested data-URL values, then
    # re-serialize. On parse failure, truncate the raw string defensively.
    try:
        parsed = json.loads(arguments)
    except (ValueError, TypeError):
        return json.dumps(_truncate_base64_media(arguments))

    return json.dumps(_truncate_base64_media(parsed))


def _build_tool_call_id_to_name(
    messages: List[ChatCompletionMessageParam],
) -> Dict[str, str]:
    """
    First pass over the messages: map every assistant ``tool_calls[].id`` to its
    ``function.name`` so that paired ``role:"tool"`` result messages — which carry
    only ``tool_call_id`` and no name — can be attributed to their function.
    """
    id_to_name: Dict[str, str] = {}
    for msg in messages:
        tool_calls = msg.get("tool_calls")
        if not isinstance(tool_calls, list):
            continue
        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            call_id = call.get("id")
            function = call.get("function")
            name = function.get("name") if isinstance(function, dict) else None
            if isinstance(call_id, str) and isinstance(name, str):
                id_to_name[call_id] = name
    return id_to_name


def _render_tool_call(call: Any) -> Optional[str]:
    """
    Renders one assistant tool call as ``<name>(<truncated-args>)``. Returns None
    when the entry is not a usable tool-call dict.
    """
    if not isinstance(call, dict):
        return None
    function = call.get("function")
    name = function.get("name") if isinstance(function, dict) else None
    if not isinstance(name, str):
        name = "unknown"
    arguments = function.get("arguments") if isinstance(function, dict) else None
    rendered_args = _render_tool_arguments(arguments)
    return f"{name}({rendered_args})"


class JudgeUtils:
    """Utilities for the Judge agent."""

    @staticmethod
    def build_transcript_from_messages(
        messages: List[ChatCompletionMessageParam],
    ) -> str:
        """
        Builds a minimal transcript from messages for judge evaluation.

        Truncates base64 media to reduce token usage. Renders assistant tool
        calls inline (``[tool_call: name(args)]``) and attributes ``role:"tool"``
        result messages to their originating function via a ``tool_call_id`` →
        name map, so tool usage is visible to the judge instead of collapsing to
        a bare ``assistant: null`` line.

        Args:
            messages: Array of ChatCompletionMessageParam from conversation

        Returns:
            Plain text transcript with one message per line
        """
        id_to_name = _build_tool_call_id_to_name(messages)

        lines = []
        for msg in messages:
            role = msg.get("role", "unknown")
            content = msg.get("content", "")
            truncated_content = _truncate_base64_media(content)

            tool_calls = msg.get("tool_calls")
            if isinstance(tool_calls, list) and tool_calls:
                # Assistant turn with tool calls. Render one [tool_call: ...]
                # segment per call, in emission order, alongside any text content.
                # When content is None/empty (the common pure-tool-call shape),
                # omit the bare `null`/`""` so the line never reads `assistant: null`.
                rendered_calls = [
                    f"[tool_call: {rendered}]"
                    for call in tool_calls
                    if (rendered := _render_tool_call(call)) is not None
                ]
                segments: List[str] = []
                if content not in (None, ""):
                    segments.append(json.dumps(truncated_content))
                segments.extend(rendered_calls)
                lines.append(f"{role}: {' '.join(segments)}")
                continue

            if role == "tool":
                # Tool result. Resolve the originating function name from the
                # id->name map built in the first pass.
                tool_call_id = msg.get("tool_call_id")
                name = (
                    id_to_name.get(tool_call_id)
                    if isinstance(tool_call_id, str)
                    else None
                ) or "unknown"
                lines.append(f"tool ({name}): {json.dumps(truncated_content)}")
                continue

            lines.append(f"{role}: {json.dumps(truncated_content)}")
        return "\n".join(lines)
