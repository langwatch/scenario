"""AC10b: capability matrix stays byte-identical when no AdapterCapabilities field is added.

No new field was added to AdapterCapabilities in issue #666's changes, so
re-running the generator must produce the exact same mdx file.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent  # worktrees/iss666/
PYTHON_DIR = REPO_ROOT / "python"
MDX_PATH = REPO_ROOT / "docs" / "docs" / "pages" / "_generated" / "voice" / "capability-matrix.mdx"


def test_ac10b_capability_matrix_byte_identical_when_no_new_field():
    """AC10b: generator output is byte-identical to the committed mdx."""
    original_content = MDX_PATH.read_text()

    result = subprocess.run(
        ["uv", "run", "python", "scripts/gen_capability_matrix.py"],
        cwd=PYTHON_DIR,
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": str(PYTHON_DIR)},
    )
    assert result.returncode == 0, f"Generator failed: {result.stderr}"

    new_content = MDX_PATH.read_text()
    # Restore original so the test is idempotent
    MDX_PATH.write_text(original_content)

    assert new_content == original_content, (
        "Capability matrix is not byte-identical after regeneration.\n"
        "If AdapterCapabilities gained a new field, update gen_capability_matrix.py "
        "COLUMNS and commit the regenerated mdx (AC10a)."
    )
