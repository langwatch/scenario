"""
Repository-wide collection guards.

Nothing here configures a test. The one job is to refuse a combination of
markers that reads as protection and provides none.
"""

from __future__ import annotations

import pytest


def pytest_collection_modifyitems(config, items):
    """Refuse ``flaky`` on a test that ``asyncio_concurrent`` owns.

    pytest-asyncio-concurrent takes grouped async tests out of the normal
    protocol: it collects them into an ``AsyncioConcurrentGroup`` and runs
    them from its own ``pytest_runtest_protocol_async_group`` hook.
    pytest-rerunfailures implements reruns in ``pytest_runtest_protocol``,
    which that group never calls, so ``@pytest.mark.flaky(reruns=N)`` on a
    concurrent test is inert. It does not warn, and the run summary counts no
    reruns, so the only way to notice is to read a failure log line by line
    and see the rerun that never happened.

    That combination cost a red CI lane: a live-LLM example carried
    ``reruns=4``, failed on its first attempt, and was reported as a hard
    failure. Failing collection is the cheapest place to say so.
    """
    offenders = []
    for item in items:
        if item.get_closest_marker("flaky") and item.get_closest_marker(
            "asyncio_concurrent"
        ):
            offenders.append(item.nodeid)
    if offenders:
        raise pytest.UsageError(
            "flaky reruns do not run under asyncio_concurrent: "
            "pytest-rerunfailures hooks pytest_runtest_protocol, which the "
            "concurrent group protocol never calls, so these markers protect "
            "nothing. Make the test deterministic, or drop the group so the "
            "test runs under the normal protocol:\n  "
            + "\n  ".join(offenders)
        )
