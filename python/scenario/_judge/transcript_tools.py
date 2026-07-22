"""
Tools for progressive transcript discovery: expand_transcript and grep_transcript.

Mirrors ``trace_tools.py``'s ``expand_trace``/``grep_trace``, but operates on
the raw conversation messages instead of OpenTelemetry spans.

Why this exists: ``JudgeSpanCollector`` only ever contains spans created by
``autotrack_litellm_calls`` — completions made through litellm in the
harness's own process. An ``AgentAdapter`` that talks to its own backend
directly (REST/SSE/gRPC/etc., not via litellm) produces tool-call messages
that never become spans, so the span-based size-management system (structure
-only digest + expand_trace/grep_trace) is blind to that content, while the
message transcript built from ``input.messages`` carries it unbounded. This
module gives the transcript itself the same bounded-discovery treatment,
keyed on the transcript's own estimated token count rather than on spans.
"""

import re
from dataclasses import dataclass
from typing import Any, List, Sequence

from openai.types.chat import ChatCompletionMessageParam

from .estimate_tokens import estimate_tokens
from .judge_utils import JudgeUtils

# Budget constants (mirrors trace_tools.py's budgets so discovery results
# stay comparably sized regardless of which discovery path produced them).
TOOL_RESULT_TOKEN_BUDGET = 4096
"""Maximum estimated tokens for a single tool result."""

TOOL_RESULT_CHAR_BUDGET = TOOL_RESULT_TOKEN_BUDGET * 4
"""Maximum characters for a single tool result (~4000 tokens * 4 chars)."""

MAX_GREP_MATCHES = 20
"""Maximum number of grep matches returned."""


@dataclass
class _IndexedMessage:
    """A message paired with its rendered transcript line and 0-based index."""

    index: int
    message: Any
    line: str


def _index_messages(
    messages: Sequence[ChatCompletionMessageParam],
) -> List[_IndexedMessage]:
    """Renders every message and pairs it with its position, preserving order.

    Order is the conversation's own order (the same order the full transcript
    renders in) — unlike spans, messages have no independent start-time to
    re-sort by, so position IS the identity discovery tools reference.
    """
    lines = JudgeUtils.render_transcript_lines(list(messages))
    return [
        _IndexedMessage(index=i, message=msg, line=line)
        for i, (msg, line) in enumerate(zip(messages, lines))
    ]


def _truncate_to_char_budget(text: str) -> str:
    """Truncates text to fit within the tool result character budget."""
    if len(text) <= TOOL_RESULT_CHAR_BUDGET:
        return text
    truncated = text[:TOOL_RESULT_CHAR_BUDGET]
    return (
        truncated
        + "\n\n[TRUNCATED] Output exceeded ~4000 token budget. "
        "Use grep_transcript(pattern) to search for specific content, "
        "or expand_transcript with fewer indices."
    )


def build_transcript_skeleton(
    messages: Sequence[ChatCompletionMessageParam],
) -> str:
    """
    Builds a structure-only view of the transcript: one line per message
    showing its index, role, tool-call name(s) if any, and estimated size —
    but not its content. Paired with expand_transcript/grep_transcript,
    mirroring format_structure_only()'s relationship to expand_trace/grep_trace
    for spans.

    Args:
        messages: The conversation messages.

    Returns:
        Plain text skeleton, one line per message.
    """
    indexed = _index_messages(messages)
    if not indexed:
        return "No messages recorded."

    lines: List[str] = [f"Messages: {len(indexed)}", ""]
    for entry in indexed:
        msg = entry.message
        role = msg.get("role", "unknown") if isinstance(msg, dict) else "unknown"
        tokens = estimate_tokens(entry.line)

        note = ""
        tool_calls = msg.get("tool_calls") if isinstance(msg, dict) else None
        if isinstance(tool_calls, list) and tool_calls:
            names = [
                call.get("function", {}).get("name", "unknown")
                for call in tool_calls
                if isinstance(call, dict)
            ]
            note = f" [tool_calls: {', '.join(names)}]"
        elif role == "tool":
            # Reuse the same "tool (name): ..." prefix the full line already
            # carries instead of re-deriving the id->name mapping here.
            prefix = entry.line.split(":", 1)[0]
            note = f" [{prefix}]"

        lines.append(f"[{entry.index}] {role}{note} (~{tokens} tokens)")

    return "\n".join(lines)


def expand_transcript(
    messages: Sequence[ChatCompletionMessageParam],
    indices: List[int],
) -> str:
    """
    Expands one or more messages from the transcript, returning their full
    rendered content.

    Args:
        messages: The full array of conversation messages.
        indices: 0-based message indices to expand (as shown in the skeleton).

    Returns:
        Formatted string with full message content, truncated to ~4096 tokens.
    """
    indexed = _index_messages(messages)

    if len(indexed) == 0:
        return "No messages recorded."

    if len(indices) == 0:
        return "Error: provide at least one message index."

    # Defensive: the tool schema declares `indices` as integers, but not
    # every litellm-routed provider enforces function-call argument types as
    # strictly as OpenAI does. A non-integer entry (e.g. a stringified "2")
    # must not crash the discovery loop -- coerce what's coercible and drop
    # the rest instead of raising (sorting a mixed-type set below would
    # otherwise TypeError).
    parsed_indices: List[int] = []
    malformed: List[Any] = []
    for raw in indices:
        try:
            parsed_indices.append(int(raw))
        except (TypeError, ValueError):
            malformed.append(raw)

    valid_range = range(len(indexed))
    selected = [entry for entry in indexed if entry.index in parsed_indices]
    out_of_range = sorted(set(parsed_indices) - set(valid_range))

    if not selected:
        return (
            f"Error: no messages matched the given indices. "
            f"Valid range: 0-{len(indexed) - 1}."
        )

    lines: List[str] = []
    for entry in selected:
        lines.append(f"[{entry.index}] {entry.line}")
    if out_of_range:
        lines.append(f"\n[Ignored out-of-range indices: {out_of_range}]")
    if malformed:
        lines.append(f"\n[Ignored non-integer indices: {malformed}]")

    return _truncate_to_char_budget("\n".join(lines).rstrip())


def grep_transcript(
    messages: Sequence[ChatCompletionMessageParam], pattern: str
) -> str:
    """
    Searches across all rendered message lines for a pattern.

    Args:
        messages: The full array of conversation messages.
        pattern: Case-insensitive search pattern.

    Returns:
        Formatted string with matches, limited to 20 results and ~4000 tokens.
    """
    indexed = _index_messages(messages)

    if len(indexed) == 0:
        return "No messages recorded."

    escaped_pattern = re.escape(pattern)
    regex = re.compile(escaped_pattern, re.IGNORECASE)

    matches = [entry for entry in indexed if regex.search(entry.line)]

    if not matches:
        roles = list(
            dict.fromkeys(
                m.get("role", "unknown") if isinstance(m, dict) else "unknown"
                for m in messages
            )
        )
        return f'No matches found for "{pattern}". Roles present: {", ".join(roles)}'

    total_matches = len(matches)
    limited = matches[:MAX_GREP_MATCHES]

    lines: List[str] = []
    for entry in limited:
        role = (
            entry.message.get("role", "unknown")
            if isinstance(entry.message, dict)
            else "unknown"
        )
        lines.append(f"--- [{entry.index}] {role} ---")
        lines.append(f"  {entry.line}")
        lines.append("")

    if total_matches > MAX_GREP_MATCHES:
        lines.append(
            f"[{total_matches - MAX_GREP_MATCHES} more matches omitted. "
            "Refine your search pattern for more specific results.]"
        )

    return _truncate_to_char_budget("\n".join(lines).rstrip())
