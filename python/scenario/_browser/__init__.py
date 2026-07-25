"""
Deciding whether a scenario run needs a browser tab, and reusing one when it doesn't.

Public surface is intentionally tiny: :func:`show_batch_run` takes a batch URL
and does the right thing for the environment it finds itself in.
"""

from .tab_handoff import (
    BatchRunLocation,
    BrowserOutcome,
    BrowserPolicy,
    resolve_browser_policy,
    scenario_tab_key,
    show_batch_run,
)

__all__ = [
    "BatchRunLocation",
    "BrowserOutcome",
    "BrowserPolicy",
    "resolve_browser_policy",
    "scenario_tab_key",
    "show_batch_run",
]
