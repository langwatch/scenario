"""SDK identity constants for scenario trace attributes.

Mirrors the TypeScript implementation in
``javascript/src/tracing/sdk-metadata.ts`` (merged PR #736).

These constants are stamped on every ``Scenario Turn`` root span so a trace
can be identified as produced by ``langwatch-scenario`` without asking the
user to re-derive it.
"""

from importlib.metadata import version, PackageNotFoundError

# ---------------------------------------------------------------------------
# Attribute key constants (shared so callers never type string literals)
# ---------------------------------------------------------------------------

ATTR_SCENARIO_SDK_NAME = "scenario.sdk.name"
"""OpenTelemetry attribute key for the scenario SDK name."""

ATTR_SCENARIO_SDK_VERSION = "scenario.sdk.version"
"""OpenTelemetry attribute key for the scenario SDK version."""

# ---------------------------------------------------------------------------
# Values
# ---------------------------------------------------------------------------

SCENARIO_SDK_NAME: str = "langwatch-scenario"
"""The distribution name of the Python scenario SDK."""


def sdk_version() -> str:
    """Return the installed ``langwatch-scenario`` package version.

    Reads from ``importlib.metadata`` at call time so it reflects the
    actual installed version rather than a hardcoded literal.

    Falls back to ``"unknown"`` when the package metadata is not available
    (e.g. editable installs without a dist-info directory) so a missing
    version never crashes a run.
    """
    try:
        return version(SCENARIO_SDK_NAME)
    except PackageNotFoundError:
        return "unknown"


#: Pre-computed version string — resolved once at module import.
SCENARIO_SDK_VERSION: str = sdk_version()

#: Convenience dict of both SDK-identity attributes, computed once.
scenario_sdk_attributes: dict[str, str] = {
    ATTR_SCENARIO_SDK_NAME: SCENARIO_SDK_NAME,
    ATTR_SCENARIO_SDK_VERSION: SCENARIO_SDK_VERSION,
}
