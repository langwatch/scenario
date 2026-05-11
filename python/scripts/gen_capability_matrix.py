"""
Generate docs/docs/pages/_generated/voice/capability-matrix.mdx from
every VoiceAgentAdapter's ``capabilities: ClassVar[AdapterCapabilities]``.

Run from the ``python/`` directory:

    uv run python scripts/gen_capability_matrix.py

Offline only — no network calls, no env vars required. The script imports
adapter classes to read their ``capabilities`` ClassVar; those imports must
not have network side-effects at module-load time.

Output is idempotent: re-running with no source change produces no diff.
The file is written between markers so hand-edits outside the markers
survive a regen (the file lives in _generated/ and is fully regenerated
each run — markers are belt-and-braces).
"""

from __future__ import annotations

import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Path setup: allow ``import scenario`` without installing the package.
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(PYTHON_DIR))

# ---------------------------------------------------------------------------
# Output path (relative to the python/ dir so the CI working-directory: python
# git-diff resolves to ../docs/docs/pages/_generated/voice/capability-matrix.mdx)
# ---------------------------------------------------------------------------
OUT_PATH = PYTHON_DIR.parent / "docs" / "docs" / "pages" / "_generated" / "voice" / "capability-matrix.mdx"

BEGIN_MARKER = "<!-- BEGIN: auto-generated -->"
END_MARKER = "<!-- END: auto-generated -->"

# ---------------------------------------------------------------------------
# Adapter registry — ordered by name for a stable, readable table.
# We import each class directly to avoid depending on the __init__ order.
# ---------------------------------------------------------------------------
from scenario.voice.adapters.composable import ComposableVoiceAgent  # noqa: E402
from scenario.voice.adapters.elevenlabs import ElevenLabsAgentAdapter  # noqa: E402
from scenario.voice.adapters.gemini_live import GeminiLiveAgentAdapter  # noqa: E402
from scenario.voice.adapters.livekit import LiveKitAgentAdapter  # noqa: E402
from scenario.voice.adapters.openai_realtime import OpenAIRealtimeAgentAdapter  # noqa: E402
from scenario.voice.adapters.pipecat import PipecatAgentAdapter  # noqa: E402
from scenario.voice.adapters.twilio import TwilioAgentAdapter  # noqa: E402
from scenario.voice.adapters.vapi import VapiAgentAdapter  # noqa: E402
from scenario.voice.adapters.webrtc import WebRTCAgentAdapter  # noqa: E402
from scenario.voice.adapters.websocket import WebSocketAgentAdapter  # noqa: E402

ADAPTERS = [
    ComposableVoiceAgent,
    ElevenLabsAgentAdapter,
    GeminiLiveAgentAdapter,
    LiveKitAgentAdapter,
    OpenAIRealtimeAgentAdapter,
    PipecatAgentAdapter,
    TwilioAgentAdapter,
    VapiAgentAdapter,
    WebRTCAgentAdapter,
    WebSocketAgentAdapter,
]

# Columns in order — matches AdapterCapabilities field order.
COLUMNS = [
    "streaming_transcripts",
    "native_vad",
    "dtmf",
    "interruption",
    "input_formats",
    "output_formats",
]

COLUMN_HEADERS = {
    "streaming_transcripts": "streaming_transcripts",
    "native_vad": "native_vad",
    "dtmf": "dtmf",
    "interruption": "interruption",
    "input_formats": "input_formats",
    "output_formats": "output_formats",
}


def _adapter_name(cls: type) -> str:
    """Strip ``AgentAdapter`` / ``Agent`` / ``Adapter`` suffix to get a readable name."""
    name = cls.__name__
    for suffix in ("AgentAdapter", "Adapter", "Agent"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def _render_value(value: object) -> str:
    """Render a capability field value as Markdown."""
    if isinstance(value, bool):
        return "✅" if value else "❌"
    if isinstance(value, list):
        if not value:
            return "—"
        return ", ".join(f"`{v}`" for v in value)
    return str(value)


def _build_table() -> str:
    """Build the Markdown capability table string."""
    header_cells = ["Adapter"] + [COLUMN_HEADERS[c] for c in COLUMNS]
    separator_cells = ["---"] + ["---"] * len(COLUMNS)

    rows: list[str] = []
    rows.append("| " + " | ".join(header_cells) + " |")
    rows.append("| " + " | ".join(separator_cells) + " |")

    for cls in ADAPTERS:
        caps = cls.capabilities
        name = _adapter_name(cls)
        cells = [name]
        for col in COLUMNS:
            cells.append(_render_value(getattr(caps, col)))
        rows.append("| " + " | ".join(cells) + " |")

    return "\n".join(rows)


def _generate() -> str:
    """Return the full MDX file content.

    MDX does not support HTML comments (<!-- ... -->), so the begin/end markers
    are written as MDX block comments ({/* ... */}) to remain valid MDX while
    still providing a recognisable sentinel for external tooling.
    """
    table = _build_table()

    return f"""\
{{/* {BEGIN_MARKER} */}}
{table}
{{/* {END_MARKER} */}}
"""


def main() -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    content = _generate()

    # Write only if content changed — keeps file mtime stable for idempotency.
    if OUT_PATH.exists() and OUT_PATH.read_text(encoding="utf-8") == content:
        print(f"No changes: {OUT_PATH}")
        return

    OUT_PATH.write_text(content, encoding="utf-8")
    print(f"Written: {OUT_PATH}")


if __name__ == "__main__":
    main()
