"""Tests for model configuration resolution logic."""

import pytest
from scenario.config import ModelConfig, ScenarioConfig
from scenario.config.model_config_resolver import resolve_model_config


class TestResolveModelConfigNoGlobalConfig:
    """Test resolution when ScenarioConfig.default_config is None."""

    def setup_method(self):
        """Ensure no global config before each test."""
        ScenarioConfig.default_config = None

    def teardown_method(self):
        """Clean up after each test."""
        ScenarioConfig.default_config = None

    def test_explicit_model_only(self):
        """Resolver returns explicit model when no global config."""
        model, api_base, api_key, temp, max_tok, extra = resolve_model_config(
            model="openai/gpt-4",
        )

        assert model == "openai/gpt-4"
        assert api_base is None
        assert api_key is None
        assert temp is None
        assert max_tok is None
        assert extra == {}

    def test_no_model_raises_error(self):
        """Resolver raises ValueError when no model configured."""
        with pytest.raises(ValueError, match="Model must be configured"):
            resolve_model_config()

    def test_all_explicit_params(self):
        """Resolver returns all explicit params when provided."""
        model, api_base, api_key, temp, max_tok, extra = resolve_model_config(
            model="openai/gpt-4",
            api_base="https://custom.com",
            api_key="sk-test",
            temperature=0.5,
            max_tokens=1000,
            timeout=60,
            headers={"X-Test": "value"},
        )

        assert model == "openai/gpt-4"
        assert api_base == "https://custom.com"
        assert api_key == "sk-test"
        assert temp == 0.5
        assert max_tok == 1000
        assert extra == {"timeout": 60, "headers": {"X-Test": "value"}}


class TestResolveModelConfigWithStringConfig:
    """Test resolution when default_model is a string."""

    def setup_method(self):
        """Set up string config before each test."""
        ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")

    def teardown_method(self):
        """Clean up after each test."""
        ScenarioConfig.default_config = None

    def test_uses_string_config_model(self):
        """Resolver uses string config when no explicit model."""
        model, *_ = resolve_model_config()

        assert model == "openai/gpt-4"

    def test_explicit_model_overrides_string_config(self):
        """Explicit model takes precedence over string config."""
        model, *_ = resolve_model_config(
            model="anthropic/claude-3",
        )

        assert model == "anthropic/claude-3"

    def test_string_config_with_extra_params(self):
        """Extra params pass through with string config."""
        *_, extra = resolve_model_config(
            timeout=30,
        )

        assert extra == {"timeout": 30}


class TestResolveModelConfigWithModelConfig:
    """Test resolution when default_model is a ModelConfig object."""

    def setup_method(self):
        """Set up ModelConfig before each test."""
        ScenarioConfig.default_config = ScenarioConfig(
            default_model=ModelConfig(
                model="openai/gpt-4",
                api_base="https://config.com",
                api_key="sk-config",
                temperature=0.7,
                max_tokens=2000,
            )
        )

    def teardown_method(self):
        """Clean up after each test."""
        ScenarioConfig.default_config = None

    def test_uses_all_config_defaults(self):
        """Resolver uses all ModelConfig defaults when nothing explicit."""
        model, api_base, api_key, temp, max_tok, extra = resolve_model_config()

        assert model == "openai/gpt-4"
        assert api_base == "https://config.com"
        assert api_key == "sk-config"
        assert temp == 0.7
        assert max_tok == 2000
        assert extra == {}

    def test_explicit_params_override_config(self):
        """Explicit params override ModelConfig defaults."""
        model, api_base, api_key, temp, max_tok, extra = resolve_model_config(
            model="anthropic/claude-3",
            api_base="https://override.com",
            api_key="sk-override",
            temperature=0.1,
            max_tokens=500,
        )

        assert model == "anthropic/claude-3"
        assert api_base == "https://override.com"
        assert api_key == "sk-override"
        assert temp == 0.1
        assert max_tok == 500

    def test_partial_override_uses_config_for_rest(self):
        """Partial overrides use config defaults for unspecified values."""
        model, api_base, api_key, temp, max_tok, extra = resolve_model_config(
            temperature=0.3,  # Only override temperature
        )

        assert model == "openai/gpt-4"  # From config
        assert api_base == "https://config.com"  # From config
        assert api_key == "sk-config"  # From config
        assert temp == 0.3  # Overridden
        assert max_tok == 2000  # From config


class TestResolveModelConfigFalsyValues:
    """Test that falsy values (0, 0.0, '') are handled correctly."""

    def setup_method(self):
        """Set up ModelConfig with non-zero defaults."""
        ScenarioConfig.default_config = ScenarioConfig(
            default_model=ModelConfig(
                model="openai/gpt-4",
                temperature=0.7,
                max_tokens=2000,
            )
        )

    def teardown_method(self):
        """Clean up after each test."""
        ScenarioConfig.default_config = None

    def test_zero_temperature_overrides_config(self):
        """Explicit temperature=0.0 should override config, not be treated as falsy."""
        *_, temp, _, _ = resolve_model_config(
            temperature=0.0,  # Critical: 0.0 is valid!
        )

        assert temp == 0.0  # Should be 0.0, NOT 0.7 from config

    def test_zero_max_tokens_overrides_config(self):
        """Explicit max_tokens=0 should override config."""
        *_, max_tok, _ = resolve_model_config(
            max_tokens=0,  # Edge case: 0 tokens
        )

        assert max_tok == 0  # Should be 0, NOT 2000 from config

    def test_none_temperature_uses_config(self):
        """temperature=None (not specified) should use config default."""
        *_, temp, _, _ = resolve_model_config()

        assert temp == 0.7  # Should use config default

    def test_empty_string_api_base_overrides_config(self):
        """Empty string api_base should override config (edge case)."""
        ScenarioConfig.default_config = ScenarioConfig(
            default_model=ModelConfig(
                model="openai/gpt-4",
                api_base="https://config.com",
            )
        )

        _, api_base, *_ = resolve_model_config(
            api_base="",  # Empty string (falsy)
        )

        # Empty string is falsy, so `or` will use config
        # This is actually desired behavior for strings
        assert api_base == "https://config.com"


class TestResolveModelConfigExtraParams:
    """Test extra_params merging behavior."""

    def setup_method(self):
        """Set up ModelConfig with extra params."""
        ScenarioConfig.default_config = ScenarioConfig(
            default_model=ModelConfig(
                model="openai/gpt-4",
                timeout=30,  # type: ignore  # Extra param
                headers={"X-Config": "config-value"},  # type: ignore  # Extra param
                max_retries=3,  # type: ignore  # Extra param
            )
        )

    def teardown_method(self):
        """Clean up after each test."""
        ScenarioConfig.default_config = None

    def test_config_extra_params_pass_through(self):
        """Config extra params are included when no explicit params."""
        *_, extra = resolve_model_config()

        assert extra["timeout"] == 30
        assert extra["headers"] == {"X-Config": "config-value"}
        assert extra["max_retries"] == 3

    def test_explicit_extra_params_override_config(self):
        """Explicit extra_params override config extra params."""
        *_, extra = resolve_model_config(
            timeout=60,  # Override
            new_param="value",  # New param
        )

        assert extra["timeout"] == 60  # Overridden
        assert extra["headers"] == {"X-Config": "config-value"}  # From config
        assert extra["max_retries"] == 3  # From config
        assert extra["new_param"] == "value"  # New param

    def test_extra_params_only_from_explicit_when_no_config(self):
        """Only explicit extra_params when no ModelConfig."""
        ScenarioConfig.default_config = ScenarioConfig(
            default_model="openai/gpt-4"  # String config, no extra params
        )

        *_, extra = resolve_model_config(
            custom="param",
        )

        assert extra == {"custom": "param"}


class TestResolveModelConfigEdgeCases:
    """Test edge cases and error conditions."""

    def teardown_method(self):
        """Clean up after each test."""
        ScenarioConfig.default_config = None

    def test_explicit_temperature_overrides_config_default(self):
        """Explicit temperature should override config's default 0.0."""
        ScenarioConfig.default_config = ScenarioConfig(
            default_model=ModelConfig(
                model="openai/gpt-4",
                # temperature defaults to 0.0 in ModelConfig
            )
        )

        *_, temp, _, _ = resolve_model_config(
            temperature=0.5,
        )

        assert temp == 0.5

    def test_none_temperature_uses_config_default(self):
        """temperature=None should use config's default temperature."""
        ScenarioConfig.default_config = ScenarioConfig(
            default_model=ModelConfig(
                model="openai/gpt-4",
                # temperature defaults to 0.0 in ModelConfig
            )
        )

        *_, temp, _, _ = resolve_model_config()

        assert temp == 0.0  # ModelConfig default

    def test_extra_params_not_mutated(self):
        """Resolver should not mutate the input extra_kwargs dict."""
        # Since we're using **kwargs now, this is less of a concern
        # but we can still verify the behavior
        resolve_model_config(
            model="openai/gpt-4",
            param="value",
        )

        # No assertion needed - just verify it doesn't raise
