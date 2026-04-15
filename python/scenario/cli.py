"""Scenario CLI entry point.

Installed as the ``scenario`` console script. Currently exposes:

  * ``scenario redteam-report`` — launch the Streamlit dashboard on a
    red-team batch directory, auto-discovering the latest batch if none
    specified.

The Streamlit app itself lives at :mod:`scenario.report.app`.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional


def _find_batch_dir(
    reports_root: Path, batch: Optional[str], latest_n: int
) -> Optional[Path]:
    """Return the batch directory to open, or None if none found."""
    if batch:
        p = reports_root / batch
        return p if p.is_dir() else None

    if not reports_root.is_dir():
        return None

    candidates = sorted(
        (p for p in reports_root.iterdir() if p.is_dir()),
        key=lambda p: p.name,
        reverse=True,
    )
    if not candidates:
        return None
    idx = max(1, latest_n) - 1
    if idx >= len(candidates):
        return None
    return candidates[idx]


def _cmd_redteam_report(args: argparse.Namespace) -> int:
    reports_root = Path(args.dir).resolve()
    batch_dir = _find_batch_dir(reports_root, args.batch, args.latest)
    if batch_dir is None:
        if args.batch:
            print(f"error: batch '{args.batch}' not found under {reports_root}", file=sys.stderr)
        elif not reports_root.is_dir():
            print(
                f"error: no reports directory at {reports_root}\n"
                f"hint: run a test with a RedTeamAgent first, or pass --dir",
                file=sys.stderr,
            )
        else:
            print(
                f"error: no batches found under {reports_root}\n"
                f"hint: run a test with a RedTeamAgent first",
                file=sys.stderr,
            )
        return 2

    if shutil.which("streamlit") is None:
        print(
            "error: streamlit is not installed.\n"
            "install with: pip install streamlit plotly pandas",
            file=sys.stderr,
        )
        return 3

    # Streamlit app lives in this package.
    app_path = Path(__file__).parent / "report" / "app.py"
    if not app_path.is_file():
        print(f"error: dashboard app not found at {app_path}", file=sys.stderr)
        return 4

    cmd = [
        "streamlit", "run", str(app_path),
        "--server.port", str(args.port),
        "--server.headless", "true" if args.no_browser else "false",
        "--",
        "--batch-dir", str(batch_dir),
    ]
    env = os.environ.copy()
    # The app reads the batch via CLI arg (see app._parse_cli_batch_dir);
    # env var duplicates it as a belt-and-suspenders fallback.
    env["SCENARIO_REDTEAM_BATCH_DIR"] = str(batch_dir)

    print(f"[scenario] opening {batch_dir}")
    print(f"[scenario] dashboard: http://localhost:{args.port}")
    return subprocess.call(cmd, env=env)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="scenario",
        description="Scenario framework command-line interface.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    rt = subparsers.add_parser(
        "redteam-report",
        help="Open the red-team Streamlit dashboard on a saved batch.",
        description=(
            "Launches the red-team findings dashboard on a batch of saved "
            "scenario reports. With no flags, opens the latest batch under "
            "./redteam-reports/."
        ),
    )
    rt.add_argument(
        "--dir",
        default=os.environ.get("SCENARIO_REDTEAM_REPORT_DIR", "./redteam-reports"),
        help="Root directory containing timestamped batch subdirectories. "
        "Defaults to $SCENARIO_REDTEAM_REPORT_DIR or ./redteam-reports.",
    )
    rt.add_argument(
        "--batch",
        default=None,
        help="Specific batch name (e.g. 20260414_143022) to open. "
        "Overrides --latest when provided.",
    )
    rt.add_argument(
        "--latest",
        type=int,
        default=1,
        help="Open the Nth-most-recent batch (1 = latest, 2 = second latest, ...). "
        "Default: 1.",
    )
    rt.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("SCENARIO_REDTEAM_PORT", "8501")),
        help="Streamlit port. Default: 8501 (or $SCENARIO_REDTEAM_PORT).",
    )
    rt.add_argument(
        "--no-browser",
        action="store_true",
        help="Don't auto-open a browser tab (headless mode, useful for SSH).",
    )
    rt.set_defaults(func=_cmd_redteam_report)

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
