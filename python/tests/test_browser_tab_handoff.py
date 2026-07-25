"""
Browser tab reuse, exercised against a real HTTP server.

Covers specs/browser-tab-reuse.feature. The LangWatch side is a real
``ThreadingHTTPServer`` answering the browser-tab handoff endpoint, so the
requests, headers, timeouts and status codes on the wire are the genuine
article. The only injected seam is the opener: tests need to know which URL
would have been opened without spawning twenty browsers on the machine running
them, and one subprocess test at the bottom proves the real ``webbrowser`` path
is wired up.
"""

import json
import os
import subprocess
import sys
import textwrap
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from scenario._browser import (
    BatchRunLocation,
    BrowserOutcome,
    BrowserPolicy,
    resolve_browser_policy,
    scenario_tab_key,
    show_batch_run,
)
from scenario._browser import tab_handoff

BROWSER_ENV_VARS = (
    "SCENARIO_BROWSER",
    "SCENARIO_BROWSER_REOPEN_SECONDS",
    "SCENARIO_HEADLESS",
    "CI",
    "LANGWATCH_STATE_DIR",
)


class FakeLangWatch:
    """A real HTTP server standing in for a LangWatch instance."""

    def __init__(self, *, delivered: bool = False, status: int = 200, delay: float = 0.0):
        self.delivered = delivered
        self.status = status
        self.delay = delay
        self.requests: List[Dict[str, Any]] = []
        self.headers: List[Dict[str, str]] = []

        server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler_class())
        self._server = server
        self._thread = threading.Thread(target=server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def endpoint(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    def _handler_class(self):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:  # keep pytest output clean
                pass

            def do_POST(self) -> None:  # noqa: N802 - stdlib naming
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length).decode("utf-8") if length else "{}"

                outer.requests.append(
                    {"path": self.path, "body": json.loads(raw)}
                )
                outer.headers.append(dict(self.headers))

                if outer.delay:
                    time.sleep(outer.delay)

                if outer.status != 200:
                    self.send_response(outer.status)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"error":"nope"}')
                    return

                body = json.dumps(
                    {"delivered": outer.delivered, "url": "http://example.test/batch"}
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        return Handler


def _run_in_subprocess(
    body: str, env_overrides: Optional[Dict[str, str]] = None
) -> "subprocess.CompletedProcess[str]":
    """
    Run a snippet against the real module in a fresh interpreter.

    The module is loaded by path rather than as ``scenario._browser`` on
    purpose: importing the whole package drags in litellm and friends, which
    costs more than the test budget and proves nothing about tab handoff.
    """
    module_path = Path(tab_handoff.__file__)
    program = textwrap.dedent(
        f"""
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "scenario_tab_handoff", {str(module_path)!r}
        )
        handoff = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(handoff)
        """
    ) + textwrap.dedent(body)

    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", ""),
        "PYTHONPATH": ":".join(sys.path),
        "LANGWATCH_STATE_DIR": os.environ["LANGWATCH_STATE_DIR"],
    }
    env.update(env_overrides or {})

    return subprocess.run(
        [sys.executable, "-c", program],
        capture_output=True,
        text=True,
        check=True,
        env=env,
        timeout=45,
    )


class RecordingOpener:
    """Stands in for the platform browser and remembers what it was handed."""

    def __init__(self) -> None:
        self.urls: List[str] = []

    def __call__(self, url: str) -> bool:
        self.urls.append(url)
        return True


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    """Give every test its own state directory and a clean environment."""
    for name in BROWSER_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("LANGWATCH_STATE_DIR", str(tmp_path / "state"))
    return tmp_path


@pytest.fixture
def opener() -> RecordingOpener:
    return RecordingOpener()


def location(set_id: Optional[str] = "checkout-flow") -> BatchRunLocation:
    return BatchRunLocation(
        batch_url="https://app.langwatch.test/proj/simulations/checkout-flow/batch-1",
        batch_run_id="batch-1",
        scenario_set_id=set_id,
    )


def show(server: Optional[FakeLangWatch], opener: RecordingOpener, **kwargs):
    return show_batch_run(
        kwargs.pop("location", location()),
        endpoint=server.endpoint if server else None,
        api_key=kwargs.pop("api_key", "sk-lw-test"),
        opener=opener,
        **kwargs,
    )


# ---------------------------------------------------------------------------
# The happy path: one tab, forever
# ---------------------------------------------------------------------------


def test_first_run_opens_a_tab_stamped_with_the_machine_key(opener):
    server = FakeLangWatch(delivered=False)
    try:
        outcome = show(server, opener)
    finally:
        server.close()

    assert outcome is BrowserOutcome.OPENED
    assert len(opener.urls) == 1
    assert f"scenarioTab={scenario_tab_key()}" in opener.urls[0]
    assert opener.urls[0].startswith(
        "https://app.langwatch.test/proj/simulations/checkout-flow/batch-1"
    )


def test_handoff_carries_the_batch_and_set_ids_with_auth(opener):
    server = FakeLangWatch(delivered=False)
    try:
        show(server, opener)
    finally:
        server.close()

    assert server.requests[0]["path"] == "/api/scenario-events/browser-tab"
    assert server.requests[0]["body"] == {
        "tabKey": scenario_tab_key(),
        "batchRunId": "batch-1",
        "scenarioSetId": "checkout-flow",
    }
    assert server.headers[0]["Authorization"] == "Bearer sk-lw-test"


def test_a_listening_tab_takes_the_run_and_no_browser_opens(opener):
    server = FakeLangWatch(delivered=True)
    try:
        outcome = show(server, opener)
    finally:
        server.close()

    assert outcome is BrowserOutcome.HANDED_OFF
    assert opener.urls == []


def test_repeat_runs_keep_landing_in_the_same_tab(opener):
    server = FakeLangWatch(delivered=True)
    try:
        outcomes = [show(server, opener) for _ in range(5)]
    finally:
        server.close()

    assert outcomes == [BrowserOutcome.HANDED_OFF] * 5
    assert opener.urls == []
    assert len(server.requests) == 5


def test_closing_the_tab_brings_the_auto_open_back(opener):
    listening = FakeLangWatch(delivered=True)
    try:
        assert show(listening, opener) is BrowserOutcome.HANDED_OFF
    finally:
        listening.close()

    gone = FakeLangWatch(delivered=False)
    try:
        assert show(gone, opener) is BrowserOutcome.OPENED
    finally:
        gone.close()

    assert len(opener.urls) == 1


def test_an_authoritative_no_tab_answer_ignores_the_throttle(opener):
    """The server knows better than the on-disk guess, every time."""
    server = FakeLangWatch(delivered=False)
    try:
        first = show(server, opener)
        second = show(server, opener)
    finally:
        server.close()

    assert [first, second] == [BrowserOutcome.OPENED, BrowserOutcome.OPENED]
    assert len(opener.urls) == 2


# ---------------------------------------------------------------------------
# Machine scoping
# ---------------------------------------------------------------------------


def test_the_tab_key_is_stable_across_calls():
    assert scenario_tab_key() == scenario_tab_key()


def test_the_tab_key_is_shared_across_processes():
    """A second process must read the key, never mint a competing one."""
    mine = scenario_tab_key()
    result = _run_in_subprocess("print(handoff.scenario_tab_key())")

    assert result.stdout.strip() == mine


def test_the_tab_key_is_shared_with_the_typescript_sdk(isolated_state):
    """
    Both SDKs read the same file, so a tab opened by pytest is reused by vitest.

    Asserted on the file rather than by importing the TypeScript SDK: the shared
    contract *is* the path and the plain-text contents.
    """
    key = scenario_tab_key()
    key_file = isolated_state / "state" / "scenario-tab-key"

    assert key_file.read_text(encoding="utf-8").strip() == key


def test_a_missing_state_directory_only_disables_reuse(monkeypatch, opener):
    monkeypatch.setenv("LANGWATCH_STATE_DIR", "/proc/nonexistent/cannot-write")

    server = FakeLangWatch(delivered=True)
    try:
        outcome = show(server, opener)
    finally:
        server.close()

    # No key means no handoff is even attempted; the run still gets a tab.
    assert outcome is BrowserOutcome.OPENED
    assert server.requests == []
    assert opener.urls == [location().batch_url]


# ---------------------------------------------------------------------------
# Degrading gracefully
# ---------------------------------------------------------------------------


def test_an_instance_without_the_endpoint_still_opens_a_tab(opener):
    server = FakeLangWatch(status=404)
    try:
        outcome = show(server, opener)
    finally:
        server.close()

    assert outcome is BrowserOutcome.OPENED
    assert len(opener.urls) == 1


def test_an_old_instance_stops_spamming_tabs_for_the_same_set(opener):
    server = FakeLangWatch(status=404)
    try:
        first = show(server, opener)
        second = show(server, opener)
        third = show(server, opener)
    finally:
        server.close()

    assert first is BrowserOutcome.OPENED
    assert second is BrowserOutcome.SUPPRESSED_BY_THROTTLE
    assert third is BrowserOutcome.SUPPRESSED_BY_THROTTLE
    assert len(opener.urls) == 1


def test_the_throttle_is_per_scenario_set(opener):
    server = FakeLangWatch(status=404)
    try:
        show(server, opener, location=location("checkout-flow"))
        outcome = show(server, opener, location=location("onboarding"))
    finally:
        server.close()

    assert outcome is BrowserOutcome.OPENED
    assert len(opener.urls) == 2


def test_the_throttle_window_is_configurable(monkeypatch, opener):
    monkeypatch.setenv("SCENARIO_BROWSER_REOPEN_SECONDS", "0")

    server = FakeLangWatch(status=404)
    try:
        first = show(server, opener)
        second = show(server, opener)
    finally:
        server.close()

    assert [first, second] == [BrowserOutcome.OPENED, BrowserOutcome.OPENED]


def test_a_hanging_langwatch_never_stalls_the_run(opener):
    server = FakeLangWatch(delivered=True, delay=5.0)
    started = time.monotonic()
    try:
        outcome = show(server, opener)
    finally:
        server.close()
    elapsed = time.monotonic() - started

    assert outcome is BrowserOutcome.OPENED
    assert elapsed < 4.5, "the handoff must time out well before the server answers"


def test_an_unreachable_langwatch_falls_back_to_opening(opener):
    # Port 1 on loopback refuses connections immediately.
    outcome = show_batch_run(
        location(),
        endpoint="http://127.0.0.1:1",
        api_key="sk-lw-test",
        opener=opener,
    )

    assert outcome is BrowserOutcome.OPENED
    assert len(opener.urls) == 1


def test_without_credentials_the_handoff_is_skipped(opener):
    server = FakeLangWatch(delivered=True)
    try:
        outcome = show(server, opener, api_key=None)
    finally:
        server.close()

    assert outcome is BrowserOutcome.OPENED
    assert server.requests == []


# ---------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        ("auto", BrowserPolicy.AUTO),
        ("never", BrowserPolicy.NEVER),
        ("always", BrowserPolicy.ALWAYS),
        ("ALWAYS", BrowserPolicy.ALWAYS),
        ("nonsense", BrowserPolicy.AUTO),
    ],
)
def test_scenario_browser_selects_the_policy(monkeypatch, value, expected):
    monkeypatch.setenv("SCENARIO_BROWSER", value)
    assert resolve_browser_policy() is expected


def test_headless_config_suppresses_the_browser():
    assert resolve_browser_policy(headless=True) is BrowserPolicy.NEVER


def test_ci_suppresses_the_browser(monkeypatch):
    monkeypatch.setenv("CI", "true")
    assert resolve_browser_policy() is BrowserPolicy.NEVER


def test_ci_set_to_false_does_not_suppress_the_browser(monkeypatch):
    monkeypatch.setenv("CI", "false")
    assert resolve_browser_policy() is BrowserPolicy.AUTO


def test_an_explicit_policy_beats_headless(monkeypatch):
    monkeypatch.setenv("SCENARIO_BROWSER", "always")
    assert resolve_browser_policy(headless=True) is BrowserPolicy.ALWAYS


def test_never_opens_nothing_and_asks_nothing(monkeypatch, opener):
    monkeypatch.setenv("SCENARIO_BROWSER", "never")

    server = FakeLangWatch(delivered=False)
    try:
        outcome = show(server, opener)
    finally:
        server.close()

    assert outcome is BrowserOutcome.SUPPRESSED_BY_POLICY
    assert opener.urls == []
    assert server.requests == []


def test_always_opens_even_when_a_tab_is_listening(monkeypatch, opener):
    monkeypatch.setenv("SCENARIO_BROWSER", "always")

    server = FakeLangWatch(delivered=True)
    try:
        first = show(server, opener)
        second = show(server, opener)
    finally:
        server.close()

    assert [first, second] == [BrowserOutcome.OPENED, BrowserOutcome.OPENED]
    assert server.requests == [], "always means always; do not consult the server"
    assert len(opener.urls) == 2


def test_headless_true_suppresses_the_browser(opener):
    server = FakeLangWatch(delivered=False)
    try:
        outcome = show(server, opener, headless=True)
    finally:
        server.close()

    assert outcome is BrowserOutcome.SUPPRESSED_BY_POLICY
    assert opener.urls == []


# ---------------------------------------------------------------------------
# The real browser path
# ---------------------------------------------------------------------------


def test_the_default_opener_goes_through_webbrowser(tmp_path):
    """
    No injected opener: prove the production path really reaches ``webbrowser``.

    ``BROWSER`` makes the stdlib shell out to a recorder instead of a browser,
    and a fresh process guarantees ``webbrowser`` reads it during its own
    lazy initialisation.
    """
    recorder = tmp_path / "opened.txt"
    launcher = tmp_path / "record-url.sh"
    launcher.write_text(f'#!/bin/sh\nprintf "%s" "$1" > {recorder}\n')
    launcher.chmod(0o755)

    result = _run_in_subprocess(
        """
        print(
            handoff.show_batch_run(
                handoff.BatchRunLocation(
                    batch_url="https://app.langwatch.test/p/simulations/s/batch-9",
                    batch_run_id="batch-9",
                    scenario_set_id="s",
                ),
                endpoint="http://127.0.0.1:1",
                api_key="sk-lw-test",
            ).value
        )
        """,
        env_overrides={"BROWSER": f"{launcher} %s"},
    )

    assert result.stdout.strip() == "opened"
    assert recorder.exists(), "webbrowser never launched the configured browser"
    assert recorder.read_text().startswith(
        "https://app.langwatch.test/p/simulations/s/batch-9?scenarioTab="
    )
