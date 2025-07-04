"""
Configuration module for Scenario.

This module provides all configuration classes for customizing the behavior
of the Scenario testing framework, including model settings, scenario execution
parameters, and LangWatch integration.

Classes:
    ModelConfig: Configuration for LLM model settings
    ScenarioConfig: Main configuration for scenario execution
    LangWatchSettings: Configuration for LangWatch API integration

Example:
    ```
    from scenario.config import ModelConfig, ScenarioConfig, LangWatchSettings

    # Configure LLM model
    model_config = ModelConfig(
        model="openai/gpt-4.1-mini",
        temperature=0.1
    )

    # Configure scenario execution
    scenario_config = ScenarioConfig(
        default_model=model_config,
        max_turns=15,
        verbose=True
    )

    # Configure LangWatch integration
    langwatch_settings = LangWatchSettings()  # Reads from environment
    ```
"""

from .model import ModelConfig
from .scenario import ScenarioConfig
from .langwatch import LangWatchSettings

__all__ = [
    "ModelConfig",
    "ScenarioConfig",
    "LangWatchSettings",
]
