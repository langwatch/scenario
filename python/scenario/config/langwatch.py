"""
LangWatch configuration for Scenario.

This module provides configuration for LangWatch API integration,
including endpoint URLs and authentication credentials.
"""

from pydantic import Field, HttpUrl
from pydantic_settings import BaseSettings, SettingsConfigDict


class LangWatchSettings(BaseSettings):
    """
    Configuration for LangWatch API integration.

    This class handles configuration for connecting to LangWatch services,
    automatically reading from environment variables with the LANGWATCH_ prefix.

    Attributes:
        endpoint: LangWatch API endpoint URL
        api_key: API key for LangWatch authentication

    Environment Variables:
        LANGWATCH_ENDPOINT: LangWatch API endpoint (defaults to https://app.langwatch.ai)
        LANGWATCH_API_KEY: API key for authentication (defaults to empty string)

    Example:
        ```
        # Using environment variables
        # export LANGWATCH_ENDPOINT="https://app.langwatch.ai"
        # export LANGWATCH_API_KEY="your-api-key"

        settings = LangWatchSettings()
        print(settings.endpoint)  # https://app.langwatch.ai
        print(settings.api_key)   # your-api-key

        # Or override programmatically
        settings = LangWatchSettings(
            endpoint="https://custom.langwatch.ai",
            api_key="your-api-key"
        )
        ```
    """

    model_config = SettingsConfigDict(env_prefix="LANGWATCH_", case_sensitive=False)

    endpoint: HttpUrl = Field(
        default=HttpUrl("https://app.langwatch.ai"),
        description="LangWatch API endpoint URL",
    )
    api_key: str = Field(default="", description="API key for LangWatch authentication")
