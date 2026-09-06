"""
Keep scenario runs in one browser tab instead of opening a new one every time.

Running a suite in a loop used to leave a trail of twenty LangWatch tabs. The
fix has three layers, tried in order:

1. **Handoff.** LangWatch knows whether a simulations tab opened by this machine
   still has a live connection. If one does, the run is pushed to that tab and
   nothing is opened locally.
2. **Throttle.** When that question can't be answered, a small on-disk record
   keeps repeat runs of the same set from opening a second tab within a
   short window.
3. **Policy.** ``SCENARIO_BROWSER`` (and the older ``SCENARIO_HEADLESS``) decide
   whether a browser may be opened at all; CI never opens one.

Every step fails open: a broken handoff, an unwritable state directory, or a
missing browser must never disturb the scenario run itself.
"""

import json
import logging
import os
import time
import uuid
import webbrowser
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlencode, urlparse, urlunparse

import httpx

logger = logging.getLogger(__name__)

#: Query param carrying this machine's tab key into the page the SDK opens.
SCENARIO_TAB_QUERY_PARAM = "scenarioTab"

#: How long the SDK waits on the handoff before giving up and opening a tab.
HANDOFF_TIMEOUT_SECONDS = 2.0

#: Default window during which the same scenario set will not reopen a tab,
#: used only when the LangWatch instance cannot answer the handoff.
DEFAULT_REOPEN_INTERVAL_SECONDS = 300


class BrowserPolicy(str, Enum):
    """Whether this process is allowed to open a browser."""

    AUTO = "auto"
    NEVER = "never"
    ALWAYS = "always"


class BrowserOutcome(str, Enum):
    """What actually happened, so callers can print something honest."""

    HANDED_OFF = "handed_off"
    OPENED = "opened"
    SUPPRESSED_BY_POLICY = "suppressed_by_policy"
    SUPPRESSED_BY_THROTTLE = "suppressed_by_throttle"
    FAILED_TO_OPEN = "failed_to_open"


@dataclass(frozen=True)
class BatchRunLocation:
    """Everything needed to point a browser at one batch of runs."""

    batch_url: str
    batch_run_id: str
    scenario_set_id: Optional[str] = None


def _state_dir() -> Path:
    override = os.getenv("LANGWATCH_STATE_DIR")
    if override:
        return Path(override)
    return Path.home() / ".langwatch"


def _is_truthy(value: Optional[str]) -> bool:
    return (value or "").strip().lower() not in ("", "0", "false", "no")


def _is_ci() -> bool:
    return _is_truthy(os.getenv("CI"))


def resolve_browser_policy(headless: bool = False) -> BrowserPolicy:
    """
    Decide the opening policy for this process.

    An explicit ``SCENARIO_BROWSER`` always wins, including over ``headless``,
    so a developer can force a tab open from a headless-by-default setup.
    """
    raw = (os.getenv("SCENARIO_BROWSER") or "").strip().lower()
    if raw:
        try:
            return BrowserPolicy(raw)
        except ValueError:
            logger.warning(
                "Unrecognized SCENARIO_BROWSER=%r, expected one of "
                "auto/never/always; falling back to auto",
                raw,
            )
            return BrowserPolicy.AUTO

    if headless or _is_ci():
        return BrowserPolicy.NEVER

    return BrowserPolicy.AUTO


def scenario_tab_key() -> Optional[str]:
    """
    Stable identifier for this machine's scenario tab, created on first use.

    Shared with the TypeScript SDK through the same file, so a tab opened by a
    ``pytest`` run is reused by a ``vitest`` run and vice versa. Returns None
    when the state directory cannot be used, which simply disables reuse.
    """
    path = _state_dir() / "scenario-tab-key"

    try:
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    except (OSError, ValueError):
        # No key yet, or one we cannot read. Either way the answer is the same:
        # mint a fresh one below.
        pass

    key = uuid.uuid4().hex

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive create: when two processes start at once, the loser reads
        # the winner's key instead of overwriting it.
        with open(path, "x", encoding="utf-8") as handle:
            handle.write(key)
        return key
    except FileExistsError:
        try:
            return path.read_text(encoding="utf-8").strip() or None
        except OSError:
            return None
    except OSError as error:
        logger.debug("Could not persist the scenario tab key: %r", error)
        return None


def _reopen_interval_seconds() -> int:
    raw = os.getenv("SCENARIO_BROWSER_REOPEN_SECONDS")
    if not raw:
        return DEFAULT_REOPEN_INTERVAL_SECONDS
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning(
            "Ignoring non-numeric SCENARIO_BROWSER_REOPEN_SECONDS=%r", raw
        )
        return DEFAULT_REOPEN_INTERVAL_SECONDS


def _throttle_path() -> Path:
    return _state_dir() / "scenario-tab-opens.json"


def _read_throttle() -> Dict[str, float]:
    try:
        raw = json.loads(_throttle_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        # No record yet, or an unreadable one; either way, nothing to honour.
        return {}

    if not isinstance(raw, dict):
        return {}

    # One malformed entry must not throw away the rest: the file is a
    # best-effort guard, and dropping it wholesale would reopen every set.
    entries: Dict[str, float] = {}
    for key, value in raw.items():
        try:
            entries[str(key)] = float(value)
        except (TypeError, ValueError):
            continue
    return entries


def _opened_recently(set_key: str, now: float) -> bool:
    interval = _reopen_interval_seconds()
    if interval <= 0:
        return False
    last = _read_throttle().get(set_key)
    return last is not None and (now - last) < interval


def _record_open(set_key: str, now: float) -> None:
    path = _throttle_path()
    entries = _read_throttle()
    entries[set_key] = now

    # Keep the file from growing forever on long-lived machines.
    interval = max(_reopen_interval_seconds(), 1)
    entries = {
        key: seen for key, seen in entries.items() if now - seen < interval * 10
    }

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(entries), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as error:
        logger.debug("Could not record the browser open time: %r", error)


def _with_tab_key(url: str, tab_key: str) -> str:
    parts = urlparse(url)
    query = parts.query
    extra = urlencode({SCENARIO_TAB_QUERY_PARAM: tab_key})
    merged = f"{query}&{extra}" if query else extra
    return urlunparse(parts._replace(query=merged))


def _request_handoff(
    *,
    endpoint: str,
    api_key: str,
    tab_key: str,
    location: BatchRunLocation,
    project_id: Optional[str] = None,
) -> Optional[bool]:
    """
    Ask LangWatch to push this batch to an already-open tab.

    Returns True when a tab took it, False when none was listening, and None
    when the instance cannot answer (an old server, a network hiccup), which
    tells the caller to fall back to its own heuristics.
    """
    payload: Dict[str, Any] = {
        "tabKey": tab_key,
        "batchRunId": location.batch_run_id,
    }
    if location.scenario_set_id:
        payload["scenarioSetId"] = location.scenario_set_id

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    if project_id:
        headers["X-Project-Id"] = project_id

    try:
        response = httpx.post(
            f"{endpoint.rstrip('/')}/api/scenario-events/browser-tab",
            json=payload,
            headers=headers,
            timeout=HANDOFF_TIMEOUT_SECONDS,
            follow_redirects=True,
        )
    except Exception as error:
        logger.debug("Browser tab handoff request failed: %r", error)
        return None

    if response.status_code == 404:
        # LangWatch predates the handoff endpoint.
        return None

    if not response.is_success:
        logger.debug(
            "Browser tab handoff returned %s: %s",
            response.status_code,
            response.text[:200],
        )
        return None

    try:
        return bool(response.json().get("delivered"))
    except Exception:
        return None


def show_batch_run(
    location: BatchRunLocation,
    *,
    headless: bool = False,
    endpoint: Optional[str] = None,
    api_key: Optional[str] = None,
    project_id: Optional[str] = None,
    opener: Optional[Callable[[str], Any]] = None,
) -> BrowserOutcome:
    """
    Put this batch of runs in front of the user, reusing their tab when possible.

    ``opener`` exists so tests can watch what would have been opened; production
    callers leave it alone and get the platform's default browser.
    """
    policy = resolve_browser_policy(headless=headless)

    if policy is BrowserPolicy.NEVER:
        return BrowserOutcome.SUPPRESSED_BY_POLICY

    tab_key = scenario_tab_key()

    if policy is BrowserPolicy.AUTO and tab_key and endpoint and api_key:
        delivered = _request_handoff(
            endpoint=endpoint,
            api_key=api_key,
            tab_key=tab_key,
            location=location,
            project_id=project_id,
        )

        if delivered is True:
            return BrowserOutcome.HANDED_OFF

        if delivered is False:
            # Authoritative "no tab is listening": open one and skip the
            # throttle, which only exists for servers that cannot answer.
            return _open(location, tab_key, record=False, opener=opener)

    now = time.time()
    set_key = location.scenario_set_id or location.batch_url

    if policy is BrowserPolicy.AUTO and _opened_recently(set_key, now):
        return BrowserOutcome.SUPPRESSED_BY_THROTTLE

    return _open(
        location, tab_key, record=True, now=now, set_key=set_key, opener=opener
    )


def _open(
    location: BatchRunLocation,
    tab_key: Optional[str],
    *,
    record: bool,
    now: Optional[float] = None,
    set_key: Optional[str] = None,
    opener: Optional[Callable[[str], Any]] = None,
) -> BrowserOutcome:
    url = _with_tab_key(location.batch_url, tab_key) if tab_key else location.batch_url

    try:
        (opener or webbrowser.open)(url)
    except Exception as error:
        logger.debug("Could not open a browser: %r", error)
        return BrowserOutcome.FAILED_TO_OPEN

    if record and set_key is not None:
        _record_open(set_key, now if now is not None else time.time())

    return BrowserOutcome.OPENED
