"""
Model configuration resolution utilities.

This module provides utilities for resolving model configuration parameters
by merging explicit arguments with global default configurations.
"""

from dataclasses import dataclass
from typing import Optional

from scenario.config import ModelConfig, ScenarioConfig


@dataclass
class ResolvedModelConfig:
    """
    Resolved model configuration with all parameters merged from explicit args and defaults.

    Attributes:
        model: The resolved model identifier
        api_base: The resolved API base URL (if any)
        api_key: The resolved API key (if any)
        temperature: The resolved temperature value (if any)
        max_tokens: The resolved max tokens value (if any)
        extra_params: Additional parameters for the model provider
    """

    model: str
    api_base: Optional[str]
    api_key: Optional[str]
    temperature: Optional[float]
    max_tokens: Optional[int]
    extra_params: dict


def resolve_model_config(
    *,
    model: Optional[str] = None,
    api_base: Optional[str] = None,
    api_key: Optional[str] = None,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    **extra_kwargs,
) -> ResolvedModelConfig:
    """
    Resolve model configuration by merging explicit params with global config.

    This function takes explicit parameter values and merges them with the global
    ScenarioConfig defaults. Explicit values always take precedence over config
    defaults. Uses None-checks (not falsy checks) to properly handle values like
    temperature=0.0.

    Args:
        model: Explicit model identifier (e.g., "openai/gpt-4")
        api_base: Explicit API base URL
        api_key: Explicit API key
        temperature: Explicit temperature value (None means "not specified")
        max_tokens: Explicit max tokens value (None means "not specified")
        **extra_kwargs: Additional parameters to pass to the model provider
                        (e.g., timeout, headers, client, etc.)

    Returns:
        ResolvedModelConfig with all values resolved from explicit params and global config.

    Raises:
        ValueError: If no model is configured either explicitly or in global config

    Example:
        ```python
        # With global config
        ScenarioConfig.default_config = ScenarioConfig(
            default_model=ModelConfig(
                model="openai/gpt-4",
                temperature=0.7,
                timeout=30
            )
        )

        # Resolve with overrides
        config = resolve_model_config(
            model=None,  # Use config default
            temperature=0.0,  # Override (important: 0.0 is valid!)
            timeout=60  # Override extra param
        )
        # Result: ResolvedModelConfig(
        #   model="openai/gpt-4",
        #   api_base=None,
        #   api_key=None,
        #   temperature=0.0,
        #   max_tokens=None,
        #   extra_params={"timeout": 60}
        # )
        ```

    Note:
        - Uses `is not None` checks to distinguish explicit values from defaults
        - This allows falsy values like temperature=0.0 to override config defaults
        - Extra params from config are merged with lower priority than explicit params
        - Any kwargs beyond the standard fields are treated as extra params
    """
    # Start with explicit params
    resolved_model = model
    resolved_api_base = api_base
    resolved_api_key = api_key
    resolved_temp = temperature
    resolved_max_tokens = max_tokens
    resolved_extra = extra_kwargs.copy()

    # Merge with global config if present
    if ScenarioConfig.default_config is not None:
        default_model = ScenarioConfig.default_config.default_model

        if isinstance(default_model, str):
            # Simple string config: just set the model
            resolved_model = resolved_model or default_model
        elif isinstance(default_model, ModelConfig):
            # Full ModelConfig: merge all fields
            resolved_model = resolved_model or default_model.model
            resolved_api_base = resolved_api_base or default_model.api_base
            resolved_api_key = resolved_api_key or default_model.api_key

            # Use None-check not falsy-check to support temperature=0.0
            if resolved_temp is None and default_model.temperature is not None:
                resolved_temp = default_model.temperature
            if resolved_max_tokens is None and default_model.max_tokens is not None:
                resolved_max_tokens = default_model.max_tokens

            # Extract extra params from config
            config_dict = default_model.model_dump(exclude_none=True)
            # Remove standard fields that we handle explicitly
            for key in ["model", "api_base", "api_key", "temperature", "max_tokens"]:
                config_dict.pop(key, None)

            # Merge: config extras < explicit extra_kwargs
            resolved_extra = {**config_dict, **extra_kwargs}

    if not resolved_model:
        raise ValueError(
            "Model must be configured either explicitly or in ScenarioConfig.default_config"
        )

    return ResolvedModelConfig(
        model=resolved_model,
        api_base=resolved_api_base,
        api_key=resolved_api_key,
        temperature=resolved_temp,
        max_tokens=resolved_max_tokens,
        extra_params=resolved_extra,
    )
