"""
CI guard: python/examples/voice/getting_started.py must remain importable.

Why subprocess, not importlib:
    getting_started.py calls sys.exit() at module level when OPENAI_API_KEY is
    absent.  It also uses bare (non-package) imports from the examples/voice/
    directory (e.g. ``from _bot_lifecycle import ...``).  Both constraints make
    importlib.import_module impractical from the test suite's process.
    subprocess.run() sidesteps both: we pass a dummy key to satisfy the env
    check, and we add the examples/voice dir to sys.path so the local imports
    resolve.  No LLM endpoint is reached — the script is never executed, only
    its top-level import chain is exercised.

Runs under python-ci.yml (``not integration`` filter); does NOT touch
voice-integration.yml or any paid API.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

EXAMPLES_VOICE_DIR = (
    Path(__file__).resolve().parent.parent.parent / "examples" / "voice"
)


def test_getting_started_is_importable():
    """getting_started.py parses and its import chain resolves without error."""
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            # Add the examples/voice directory to sys.path so local bare
            # imports (_bot_lifecycle, scenario, ...) resolve, then import
            # the module.  Import-only — main() is never called.
            (
                "import sys; "
                f"sys.path.insert(0, {str(EXAMPLES_VOICE_DIR)!r}); "
                "import getting_started"
            ),
        ],
        capture_output=True,
        text=True,
        # Supply a dummy key so the sys.exit() guard in the module doesn't
        # trigger.  The value is never sent to any API — import-only.
        env={
            **_clean_env(),
            "OPENAI_API_KEY": "sk-dummy-for-import-check",
        },
    )
    assert result.returncode == 0, (
        f"getting_started.py failed to import.\n"
        f"stdout: {result.stdout}\n"
        f"stderr: {result.stderr}"
    )


def test_getting_started_file_exists():
    """The canonical source file is present at the expected path."""
    source = EXAMPLES_VOICE_DIR / "getting_started.py"
    assert source.exists(), f"Expected source file at {source}"


def _clean_env() -> dict:
    """Pass the current environment through; caller overrides OPENAI_API_KEY with a dummy."""
    import os

    return {k: v for k, v in os.environ.items()}
