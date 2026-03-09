"""Tests for tracing setup module."""

import pytest
from unittest.mock import MagicMock, patch
from opentelemetry.sdk.trace import TracerProvider

from scenario._tracing.setup import (
    setup_scenario_tracing,
    ensure_tracing_initialized,
    _get_concrete_provider,
    _reset_tracing_for_tests,
)


@pytest.fixture(autouse=True)
def reset_tracing():
    """Reset tracing state before and after each test."""
    _reset_tracing_for_tests()
    yield
    _reset_tracing_for_tests()


class TestEnsureTracingInitialized:
    """Tests for ensure_tracing_initialized."""

    @patch("scenario._tracing.setup._do_setup")
    def test_calls_setup_on_first_call(self, mock_do_setup: MagicMock) -> None:
        ensure_tracing_initialized()

        mock_do_setup.assert_called_once()

    @patch("scenario._tracing.setup._do_setup")
    def test_is_idempotent(self, mock_do_setup: MagicMock) -> None:
        ensure_tracing_initialized()
        ensure_tracing_initialized()
        ensure_tracing_initialized()

        mock_do_setup.assert_called_once()


class TestSetupScenarioTracing:
    """Tests for setup_scenario_tracing."""

    @patch("scenario._tracing.setup._do_setup")
    def test_calls_setup_on_first_call(self, mock_do_setup: MagicMock) -> None:
        setup_scenario_tracing()

        mock_do_setup.assert_called_once()

    @patch("scenario._tracing.setup._do_setup")
    def test_prevents_double_init(self, mock_do_setup: MagicMock) -> None:
        setup_scenario_tracing()
        setup_scenario_tracing()

        mock_do_setup.assert_called_once()

    @patch("scenario._tracing.setup._do_setup")
    def test_prevents_lazy_init_after_explicit(self, mock_do_setup: MagicMock) -> None:
        setup_scenario_tracing()
        ensure_tracing_initialized()

        mock_do_setup.assert_called_once()

    @patch("scenario._tracing.setup._do_setup")
    def test_passes_options_to_do_setup(self, mock_do_setup: MagicMock) -> None:
        filter_fn = MagicMock()
        processor = MagicMock()
        exporter = MagicMock()

        setup_scenario_tracing(
            span_filter=filter_fn,
            span_processors=[processor],
            trace_exporter=exporter,
            instrumentors=[],
        )

        mock_do_setup.assert_called_once_with(
            span_filter=filter_fn,
            span_processors=[processor],
            trace_exporter=exporter,
            instrumentors=[],
        )


class TestGetConcreteProvider:
    """Tests for _get_concrete_provider."""

    def test_returns_tracer_provider_directly(self) -> None:
        provider = TracerProvider()

        result = _get_concrete_provider(provider)

        assert result is provider

    def test_returns_delegate_from_get_delegate(self) -> None:
        concrete = TracerProvider()

        class FakeProxy:
            def get_delegate(self):
                return concrete

        proxy = FakeProxy()

        result = _get_concrete_provider(proxy)

        assert result is concrete

    def test_returns_delegate_from_private_attr(self) -> None:
        concrete = TracerProvider()

        class FakeProxy:
            def __init__(self):
                self._delegate = concrete

        proxy = FakeProxy()

        result = _get_concrete_provider(proxy)

        assert result is concrete

    def test_returns_none_for_non_provider(self) -> None:
        class FakeProxy:
            pass

        proxy = FakeProxy()

        result = _get_concrete_provider(proxy)

        assert result is None


class TestResetTracingForTests:
    """Tests for _reset_tracing_for_tests."""

    @patch("scenario._tracing.setup._do_setup")
    def test_allows_reinitialization(self, mock_do_setup: MagicMock) -> None:
        ensure_tracing_initialized()
        assert mock_do_setup.call_count == 1

        _reset_tracing_for_tests()
        ensure_tracing_initialized()
        assert mock_do_setup.call_count == 2
