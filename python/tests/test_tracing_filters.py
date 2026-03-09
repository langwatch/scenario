"""Tests for tracing filter presets."""

import pytest
from unittest.mock import MagicMock
from scenario._tracing.filters import scenario_only, with_custom_scopes, _get_scope_name


def _make_span_with_scope(scope_name: str) -> MagicMock:
    """Create a mock span with the given instrumentation scope name."""
    span = MagicMock()
    scope = MagicMock()
    scope.name = scope_name
    span.instrumentation_scope = scope
    return span


def _make_span_without_scope() -> MagicMock:
    """Create a mock span with no instrumentation scope."""
    span = MagicMock(spec=[])
    return span


class TestGetScopeName:
    """Tests for _get_scope_name helper."""

    def test_returns_scope_name_from_instrumentation_scope(self) -> None:
        span = _make_span_with_scope("langwatch")

        result = _get_scope_name(span)

        assert result == "langwatch"

    def test_returns_scope_name_from_instrumentation_info(self) -> None:
        span = MagicMock(spec=[])
        span.instrumentation_scope = None
        info = MagicMock()
        info.name = "my-lib"
        span.instrumentation_info = info

        result = _get_scope_name(span)

        assert result == "my-lib"

    def test_returns_unknown_when_no_scope_available(self) -> None:
        span = _make_span_without_scope()

        result = _get_scope_name(span)

        assert result == "unknown"

    def test_returns_unknown_when_scope_has_no_name(self) -> None:
        span = MagicMock()
        scope = MagicMock(spec=[])  # No 'name' attribute
        span.instrumentation_scope = scope

        result = _get_scope_name(span)

        assert result == "unknown"


class TestScenarioOnly:
    """Tests for scenario_only filter."""

    def test_accepts_scenario_scoped_spans(self) -> None:
        span = _make_span_with_scope("langwatch")

        assert scenario_only(span) is True

    def test_rejects_other_scopes(self) -> None:
        span = _make_span_with_scope("opentelemetry.instrumentation.flask")

        assert scenario_only(span) is False

    def test_rejects_unknown_scope(self) -> None:
        span = _make_span_without_scope()

        assert scenario_only(span) is False


class TestWithCustomScopes:
    """Tests for with_custom_scopes filter factory."""

    def test_accepts_scenario_scope(self) -> None:
        filter_fn = with_custom_scopes("my-app/database")
        span = _make_span_with_scope("langwatch")

        assert filter_fn(span) is True

    def test_accepts_custom_scope(self) -> None:
        filter_fn = with_custom_scopes("my-app/database", "my-app/agent")
        span = _make_span_with_scope("my-app/database")

        assert filter_fn(span) is True

    def test_accepts_multiple_custom_scopes(self) -> None:
        filter_fn = with_custom_scopes("my-app/database", "my-app/agent")
        span = _make_span_with_scope("my-app/agent")

        assert filter_fn(span) is True

    def test_rejects_unlisted_scopes(self) -> None:
        filter_fn = with_custom_scopes("my-app/database")
        span = _make_span_with_scope("opentelemetry.instrumentation.flask")

        assert filter_fn(span) is False

    def test_rejects_unknown_scope(self) -> None:
        filter_fn = with_custom_scopes("my-app/database")
        span = _make_span_without_scope()

        assert filter_fn(span) is False
