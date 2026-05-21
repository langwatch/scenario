"""
Generate docs/docs/pages/_generated/voice/capability-matrix.mdx from
every VoiceAgentAdapter's ``capabilities: ClassVar[AdapterCapabilities]``.

Run from the ``python/`` directory:

    uv run python scripts/gen_capability_matrix.py

Offline only — no network calls, no env vars required. The script imports
adapter classes to read their ``capabilities`` ClassVar; those imports must
not have network side-effects at module-load time.

Output is idempotent: re-running with no source change produces no diff.
The file lives in _generated/ and is fully regenerated each run.

Adapter discovery is dynamic: all direct concrete subclasses of
``VoiceAgentAdapter`` are discovered after importing
``scenario.voice.adapters`` (which triggers every adapter module).
Sorted by class name for a stable, deterministic table. If a developer
adds a new adapter file under ``scenario/voice/adapters/`` and imports it
in ``__init__.py``, the matrix picks it up automatically — no manual list
to update.
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
# Adapter registry — discovered dynamically from VoiceAgentAdapter subclasses.
#
# Importing ``scenario.voice.adapters`` triggers every adapter module's
# import, registering all concrete adapter classes as subclasses of
# VoiceAgentAdapter. We then take only *direct* subclasses (depth=1) so
# that user-composable helpers like ElevenLabsVoiceAgent (which inherits
# from ComposableVoiceAgent, not VoiceAgentAdapter directly) are not
# included in the matrix unless they are explicitly first-party adapters.
# Sorted by class name for a stable, deterministic table order.
# ---------------------------------------------------------------------------
import importlib  # noqa: E402

from scenario.voice.adapter import VoiceAgentAdapter  # noqa: E402

# Side-effect import: instantiating the adapters package registers all
# concrete VoiceAgentAdapter subclasses. We do not need a name binding.
importlib.import_module("scenario.voice.adapters")

ADAPTERS = sorted(
    VoiceAgentAdapter.__subclasses__(),
    key=lambda cls: cls.__name__,
)

# Columns in order — matches AdapterCapabilities field order.
COLUMNS = [
    "streaming_transcripts",
    "native_vad",
    "dtmf",
    "interruption",
    "input_formats",
    "output_formats",
]


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
    header_cells = ["Adapter"] + list(COLUMNS)
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
