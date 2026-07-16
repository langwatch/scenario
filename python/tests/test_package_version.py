"""Unit tests for the public ``scenario.__version__`` constant.

``__version__`` sat at ``"0.1.0"`` from the first release through 0.7.31,
because nothing bumps it: release-please updates ``pyproject.toml``, the
changelog and the manifest, and the config declares no ``extra-files``.

These tests pin it to package metadata, the same source
``scenario.sdk.version`` already reads, so it cannot silently drift again.
"""

from __future__ import annotations

import os
from importlib.metadata import version as pkg_version

os.environ.setdefault("SCENARIO_HEADLESS", "true")

import scenario
from scenario._tracing.sdk_metadata import SCENARIO_SDK_NAME, SCENARIO_SDK_VERSION


def test_version_matches_installed_package_metadata():
    assert scenario.__version__ == pkg_version(SCENARIO_SDK_NAME)


def test_version_matches_the_version_stamped_on_traces():
    # A run's trace and the importing code must never disagree about which
    # SDK version produced it.
    assert scenario.__version__ == SCENARIO_SDK_VERSION


def test_version_is_not_a_hardcoded_literal():
    # Guards the actual regression: a literal reintroduced here would pass the
    # assertions above only until the next release bumps pyproject.toml.
    import ast
    import pathlib

    source = pathlib.Path(scenario.__file__).read_text()
    tree = ast.parse(source)

    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(
            isinstance(t, ast.Name) and t.id == "__version__" for t in node.targets
        ):
            continue
        assert not isinstance(node.value, ast.Constant), (
            "__version__ must derive from package metadata, not a literal: "
            "a literal drifts on the next release (see issue #744's AC, and "
            "the 0.1.0 vs 0.7.31 drift this test was added for)"
        )
