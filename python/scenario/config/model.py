"""
Model configuration for Scenario.

This module provides configuration classes for LLM model settings used by
user simulator and judge agents in the Scenario framework.
"""

from typing import Optional
from pydantic import BaseModel, ConfigDict


class ModelConfig(BaseModel):
    """
    Configuration for LLM model settings.

    This class encapsulates all the parameters needed to configure an LLM model
    for use with user simulator and judge agents in the Scenario framework.

    The ModelConfig accepts any additional parameters that litellm supports,
    including headers, timeout, client, and other provider-specific options.

    Attributes:
        model: The model identifier (e.g., "openai/gpt-4.1", "anthropic/claude-3-sonnet")
        api_base: Optional base URL where the model is hosted
        api_key: Optional API key for the model provider
        temperature: Sampling temperature for response generation (0.0 = deterministic, 1.0 = creative)
        max_tokens: Maximum number of tokens to generate in responses

    Example:
        ```
        # Basic configuration
        model_config = ModelConfig(
            model="openai/gpt-4.1",
            api_base="https://api.openai.com/v1",
            api_key="your-api-key",
            temperature=0.1,
            max_tokens=1000
        )

        # With custom headers and timeout
        model_config = ModelConfig(
            model="openai/gpt-4",
            headers={"X-Custom-Header": "value"},
            timeout=60,
            num_retries=3
        )

        # With custom OpenAI client
        from openai import OpenAI
        model_config = ModelConfig(
            model="openai/gpt-4",
            client=OpenAI(
                base_url="https://custom.com",
                default_headers={"X-Auth": "token"}
            )
        )
        ```
    """

    model_config = ConfigDict(extra="allow")

    model: str
    api_base: Optional[str] = None
    api_key: Optional[str] = None
    temperature: float = 0.0
    max_tokens: Optional[int] = None
