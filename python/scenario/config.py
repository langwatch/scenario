"""
Configuration module for Scenario.

This module provides configuration classes for customizing the behavior of the
Scenario testing framework, including LLM model settings, execution parameters,
and debugging options.
"""

from typing import Optional, Union, ClassVar
from pydantic import BaseModel


class ModelConfig(BaseModel):
    """
    Configuration for LLM model settings.

    This class encapsulates all the parameters needed to configure an LLM model
    for use with user simulator and judge agents in the Scenario framework.

    Attributes:
        model: The model identifier (e.g., "openai/gpt-4.1-mini", "anthropic/claude-3-sonnet")
        api_key: Optional API key for the model provider
        temperature: Sampling temperature for response generation (0.0 = deterministic, 1.0 = creative)
        max_tokens: Maximum number of tokens to generate in responses

    Example:
        ```
        model_config = ModelConfig(
            model="openai/gpt-4.1-mini",
            api_key="your-api-key",
            temperature=0.1,
            max_tokens=1000
        )
        ```
    """

    model: str
    api_key: Optional[str] = None
    temperature: float = 0.0
    max_tokens: Optional[int] = None


class ScenarioConfig(BaseModel):
    """
    Global configuration class for the Scenario testing framework.

    This class allows users to set default behavior and parameters that apply
    to all scenario executions, including the LLM model to use for simulator
    and judge agents, execution limits, and debugging options.

    Attributes:
        default_model: Default LLM model configuration for agents (can be string or ModelConfig)
        max_turns: Maximum number of conversation turns before scenario times out
        verbose: Whether to show detailed output during execution (True/False or verbosity level)
        cache_key: Key for caching scenario results to ensure deterministic behavior
        debug: Whether to enable debug mode with step-by-step interaction

    Example:
        ```
        # Configure globally for all scenarios
        scenario.configure(
            default_model="openai/gpt-4.1-mini",
            max_turns=15,
            verbose=True,
            cache_key="my-test-suite-v1",
            debug=False
        )

        # Or create a specific config instance
        config = ScenarioConfig(
            default_model=ModelConfig(
                model="openai/gpt-4.1-mini",
                temperature=0.2
            ),
            max_turns=20
        )
        ```
    """

    default_model: Optional[Union[str, ModelConfig]] = None
    max_turns: Optional[int] = 10
    verbose: Optional[Union[bool, int]] = True
    cache_key: Optional[str] = None
    debug: Optional[bool] = False

    default_config: ClassVar[Optional["ScenarioConfig"]] = None

    @classmethod
    def configure(
        cls,
        default_model: Optional[str] = None,
        max_turns: Optional[int] = None,
        verbose: Optional[Union[bool, int]] = None,
        cache_key: Optional[str] = None,
        debug: Optional[bool] = None,
    ) -> None:
        """
        Set global configuration settings for all scenario executions.

        This method allows you to configure default behavior that will be applied
        to all scenarios unless explicitly overridden in individual scenario runs.

        Args:
            default_model: Default LLM model identifier for user simulator and judge agents
            max_turns: Maximum number of conversation turns before timeout (default: 10)
            verbose: Enable verbose output during scenario execution
            cache_key: Cache key for deterministic scenario behavior across runs
            debug: Enable debug mode for step-by-step execution with user intervention

        Example:
            ```
            import scenario

            # Set up default configuration
            scenario.configure(
                default_model="openai/gpt-4.1-mini",
                max_turns=15,
                verbose=True,
                debug=False
            )

            # All subsequent scenario runs will use these defaults
            result = await scenario.run(
                name="my test",
                description="Test scenario",
                agents=[my_agent, scenario.UserSimulatorAgent(), scenario.JudgeAgent()]
            )
            ```
        """
        existing_config = cls.default_config or ScenarioConfig()

        cls.default_config = existing_config.merge(
            ScenarioConfig(
                default_model=default_model,
                max_turns=max_turns,
                verbose=verbose,
                cache_key=cache_key,
                debug=debug,
            )
        )

    def merge(self, other: "ScenarioConfig") -> "ScenarioConfig":
        """
        Merge this configuration with another configuration.

        Values from the other configuration will override values in this
        configuration where they are not None.

        Args:
            other: Another ScenarioConfig instance to merge with

        Returns:
            A new ScenarioConfig instance with merged values

        Example:
            ```
            base_config = ScenarioConfig(max_turns=10, verbose=True)
            override_config = ScenarioConfig(max_turns=20)

            merged = base_config.merge(override_config)
            # Result: max_turns=20, verbose=True
            ```
        """
        return ScenarioConfig(
            **{
                **self.items(),
                **other.items(),
            }
        )

    def items(self):
        """
        Get configuration items as a dictionary.

        Returns:
            Dictionary of configuration key-value pairs, excluding None values

        Example:
            ```
            config = ScenarioConfig(max_turns=15, verbose=True)
            items = config.items()
            # Result: {"max_turns": 15, "verbose": True}
            ```
        """
        return {k: getattr(self, k) for k in self.model_dump(exclude_none=True).keys()}
