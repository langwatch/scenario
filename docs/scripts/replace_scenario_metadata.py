"""
Replace Scenario docs meta descriptions using a CSV mapping.

Default CSV: c:\\Users\\aryan\\Downloads\\Langwatch_MetaDesc.csv
Columns used:
- Meta description (OLD): text to find
- Meta NEW: replacement text
- URL: kept for reporting

Usage:
  # dry run (recommended first)
  python docs/scripts/replace_scenario_metadata.py

  # apply changes
  python docs/scripts/replace_scenario_metadata.py --apply
"""
import argparse
import csv
import json
import re
import sys
from functools import lru_cache
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Tuple
from urllib.parse import urlparse

DEFAULT_CSV = r"c:\Users\aryan\Downloads\Langwatch_MetaDesc.csv"
# Default to the Scenario docs directory (docs/docs) relative to this file.
DEFAULT_ROOT = Path(__file__).resolve().parents[1] / "docs"
# Only apply rows whose URL starts with this prefix.
DEFAULT_URL_PREFIX = "https://scenario.langwatch.ai"

# Text-based extensions to scan (tuned for the docs site)
DEFAULT_EXTS = {".md", ".mdx"}

# Directories to skip while scanning
SKIP_DIRS = {
    "node_modules",
    ".git",
    ".next",
    ".turbo",
    "dist",
    "build",
    ".cache",
}


@dataclass
class Mapping:
    new: str
    url: str


def resolve_csv_path(raw: Path) -> Path:
    """
    Allow Windows-style paths when running inside WSL.
    If the given path does not exist, try converting `C:\\foo\\bar` to `/mnt/c/foo/bar`.
    """
    if raw.exists():
        return raw
    m = re.match(r"^([a-zA-Z]):\\\\?(.*)$", str(raw))
    if m:
        drive = m.group(1).lower()
        rest = m.group(2).replace("\\", "/")
        alt = Path(f"/mnt/{drive}/{rest}")
        if alt.exists():
            return alt
    return raw


def load_mapping(csv_path: Path, url_prefix: str) -> Dict[str, Mapping]:
    if not csv_path.exists():
        raise FileNotFoundError(f"CSV not found: {csv_path}")

    with csv_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        required = {"Meta description (OLD)", "Meta NEW"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"Missing required columns: {', '.join(sorted(missing))}")

        mapping: Dict[str, Mapping] = {}
        conflicts: List[Tuple[str, str, str, int]] = []
        skipped_prefix: int = 0
        for idx, row in enumerate(reader, start=2):  # header is line 1
            old = (row.get("Meta description (OLD)", "") or "").strip()
            new = (row.get("Meta NEW", "") or "").strip()
            url = (row.get("URL", "") or "").strip()
            if not old or not new:
                continue
            if url_prefix and not url.startswith(url_prefix):
                skipped_prefix += 1
                continue
            if old in mapping and mapping[old].new != new:
                # keep the first occurrence, record conflict for reporting
                conflicts.append((old, mapping[old].new, new, idx))
                continue
            mapping[old] = Mapping(new=new, url=url)

    if conflicts:
        print("Detected conflicting rows (kept the first occurrence for each):")
        for old, kept, skipped, idx in conflicts:
            print(f"- Row {idx}: {old!r} -> {skipped!r} (kept existing: {kept!r})")
    if skipped_prefix:
        print(
            f"Skipped {skipped_prefix} row(s) whose URL did not start with prefix: {url_prefix}"
        )

    return mapping


def iter_text_files(root: Path, exts: Iterable[str]) -> Iterable[Path]:
    for path in root.rglob("*"):
        if path.is_dir():
            if path.name in SKIP_DIRS:
                # Skip entire subtree
                continue
            continue
        if path.suffix.lower() in exts:
            yield path


def apply_replacements(
    path: Path, mapping: Dict[str, Mapping], apply: bool
) -> Tuple[bool, Dict[str, int]]:
    text = path.read_text(encoding="utf-8")
    replaced = False
    counts: Dict[str, int] = {}
    new_text = text

    for old, m in mapping.items():
        occurrences = len(re.findall(re.escape(old), new_text))
        if occurrences:
            counts[old] = occurrences
            if apply:
                new_text = re.sub(re.escape(old), m.new, new_text)
                replaced = True

    if apply and replaced and new_text != text:
        path.write_text(new_text, encoding="utf-8")

    return replaced, counts


@lru_cache(maxsize=512)
def resolve_doc_path(root: Path, url: str) -> Path | None:
    """
    Map a doc URL to a local file path under docs/docs/pages.
    Supports:
    - Stripping domain, handling trailing slashes.
    - Removing trailing index.html or .html.
    - Trying .mdx, .md, and directory index files.
    """
    parsed = urlparse(url)
    path = parsed.path or "/"
    path = path.strip("/")
    # Remove trailing index.html or .html
    if path.endswith("index.html"):
        path = path[: -len("index.html")].rstrip("/")
    elif path.endswith(".html"):
        path = path[: -len(".html")]
    # Default to index
    if not path:
        path = "index"

    base = root / "pages"
    candidates = [
        base / f"{path}.mdx",
        base / f"{path}.md",
        base / path / "index.mdx",
        base / path / "index.md",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def update_frontmatter_description(content: str, new_desc: str) -> str:
    """
    Replace or add description in YAML frontmatter.
    If no frontmatter is present, frontmatter will be added.
    """
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            _, fm_body, rest = parts[0], parts[1], parts[2]
            lines = fm_body.strip("\n").splitlines()
            out_lines = []
            found = False
            for line in lines:
                if re.match(r"^description\s*:", line):
                    out_lines.append(f'description: {new_desc}')
                    found = True
                else:
                    out_lines.append(line)
            if not found:
                out_lines.append(f'description: {new_desc}')
            fm_new = "\n".join(out_lines)
            return "---\n" + fm_new + "\n---" + rest
    # No frontmatter; add one
    return f"---\ndescription: {new_desc}\n---\n{content}"


def apply_url_targeted_replacements(
    root: Path, mapping: Dict[str, Mapping], apply: bool
) -> Tuple[List[Tuple[Path, Mapping]], List[Tuple[str, str]]]:
    """
    Replace frontmatter descriptions based on URL-to-file mapping.
    Returns:
    - list of (path, mapping) that were matched (or would be changed)
    - list of (url, reason) for misses
    """
    hits: List[Tuple[Path, Mapping]] = []
    misses: List[Tuple[str, str]] = []

    for old, m in mapping.items():
        target_path = resolve_doc_path(root, m.url)
        if not target_path:
            misses.append((m.url, "no local file for URL"))
            continue
        try:
            content = target_path.read_text(encoding="utf-8")
        except Exception as exc:  # pragma: no cover - IO guard
            misses.append((m.url, f"read error: {exc}"))
            continue
        new_content = update_frontmatter_description(content, m.new)
        if new_content != content:
            hits.append((target_path, m))
            if apply:
                target_path.write_text(new_content, encoding="utf-8")
        else:
            # Already matches desired state
            hits.append((target_path, m))
    return hits, misses


def summarize(
    text_scan_results: List[Tuple[Path, Dict[str, int]]],
    url_hits: List[Tuple[Path, Mapping]],
    url_misses: List[Tuple[str, str]],
    mapping: Dict[str, Mapping],
    report_path: Path,
):
    total_text_files = len(text_scan_results)
    total_text_hits = sum(sum(counts.values()) for _, counts in text_scan_results)
    print(f"Text scan - files with matches: {total_text_files}")
    print(f"Text scan - total occurrences: {total_text_hits}")
    for path, counts in sorted(text_scan_results, key=lambda x: str(x[0])):
        print(f"- {path}")
        for old, count in counts.items():
            info = mapping.get(old)
            url = info.url if info else ""
            print(f"  * {count}x '{old}' -> '{info.new if info else ''}' (URL: {url})")

    print("\nFrontmatter updates (URL-targeted):")
    for path, m in sorted(url_hits, key=lambda x: str(x[0])):
        print(f"- {path} <- {m.url}")

    if url_misses:
        print("\nSkipped URLs (no local file):")
        for url, reason in url_misses:
            print(f"- {url} ({reason})")

    report = {
        "text_scan": {
            "files_with_matches": total_text_files,
            "total_occurrences": total_text_hits,
            "files": [
                {
                    "path": str(path),
                    "occurrences": counts,
                    "urls": {old: mapping[old].url for old in counts if old in mapping},
                }
                for path, counts in text_scan_results
            ],
        },
        "frontmatter_updates": {
            "hits": [{"path": str(p), "url": m.url, "new": m.new} for p, m in url_hits],
            "misses": [{"url": url, "reason": reason} for url, reason in url_misses],
        },
    }
    print("\nJSON summary:")
    print(json.dumps(report, indent=2))
    if report_path:
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\nReport written to: {report_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Replace Scenario docs meta descriptions using a CSV mapping."
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=Path(DEFAULT_CSV),
        help="Path to CSV file with columns: Meta description (OLD), Meta NEW, URL.",
    )
    parser.add_argument(
        "--url-prefix",
        type=str,
        default=DEFAULT_URL_PREFIX,
        help="Only apply rows whose URL starts with this prefix (default: scenario docs).",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_ROOT,
        help="Root directory to scan (defaults to docs/docs).",
    )
    parser.add_argument(
        "--exts",
        type=str,
        default=",".join(sorted(DEFAULT_EXTS)),
        help="Comma-separated list of file extensions to scan.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write changes. If omitted, runs in dry-run mode.",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("scenario_meta_report.json"),
        help="Path to write JSON summary (default: scenario_meta_report.json).",
    )
    args = parser.parse_args()

    exts = {ext.strip().lower() for ext in args.exts.split(",") if ext.strip()}
    csv_path = resolve_csv_path(args.csv)
    mapping = load_mapping(csv_path, args.url_prefix)
    print(
        f"Loaded {len(mapping)} mappings from {csv_path} with URL prefix {args.url_prefix}"
    )

    root = args.root
    if not root.exists():
        raise FileNotFoundError(f"Root directory not found: {root}")

    # Legacy text scan (kept for compatibility; often zero for Scenario docs)
    text_scan_results: List[Tuple[Path, Dict[str, int]]] = []
    files_scanned = 0

    for file_path in iter_text_files(root, exts):
        files_scanned += 1
        _, counts = apply_replacements(file_path, mapping, apply=args.apply)
        if counts:
            text_scan_results.append((file_path, counts))

    # URL-targeted frontmatter description updates
    url_hits, url_misses = apply_url_targeted_replacements(root, mapping, apply=args.apply)

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"\nMode: {mode}")
    print(f"Root: {root}")
    print(f"Files scanned: {files_scanned}")
    summarize(text_scan_results, url_hits, url_misses, mapping, args.report)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # pragma: no cover - CLI helper
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


