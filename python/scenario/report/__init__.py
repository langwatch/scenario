"""Post-hoc report generation for red-team scenario runs.

Public API:
    scenario.save_redteam_report(result, red_team=..., test_name=...)

Each call writes a JSON file into a timestamped batch directory under
``./redteam-reports/`` (one directory per Python process by default).
The ``scenario.report.app`` module is a Streamlit dashboard that reads
from such a directory.
"""

from ._save import save_redteam_report, set_batch_dir, current_batch_dir
from ._aggregate import aggregate_fixes, load_or_generate as load_or_generate_fixes

# Skip the Streamlit dashboard entry point during pdoc API doc generation.
# `app` is launched via `streamlit run`, not imported, and `streamlit` is an
# optional extra (`pip install langwatch-scenario[report]`) so the docs build
# environment can't import it.
__pdoc__ = {"app": False}

__all__ = [
    "save_redteam_report",
    "set_batch_dir",
    "current_batch_dir",
    "aggregate_fixes",
    "load_or_generate_fixes",
]
