"""
Model configuration for Scenario.

This module provides configuration classes for LLM model settings used by
user simulator and judge agents in the Scenario framework.
"""

from typing import Optional
from pydantic import BaseModel


class ModelConfig(BaseModel):
    """
    Configuration for LLM model settings.

    This class encapsulates all the parameters needed to configure an LLM model
    for use with user simulator and judge agents in the Scenario framework.

    Attributes:
        model: The model identifier (e.g., "openai/gpt-4.1", "anthropic/claude-3-sonnet")
        api_base: Optional base URL where the model is hosted
        api_key: Optional API key for the model provider
        temperature: Sampling temperature for response generation (0.0 = deterministic, 1.0 = creative)
        max_tokens: Maximum number of tokens to generate in responses

    Example:
        ```
        model_config = ModelConfig(
            model="openai/gpt-4.1",
            api_base="https://api.openai.com/v1",
            api_key="your-api-key",
            temperature=0.1,
            max_tokens=1000
        )
        ```
    """

    model: str
    api_base: Optional[str] = None
    api_key: Optional[str] = None
    temperature: float = 0.0
    max_tokens: Optional[int] = None
