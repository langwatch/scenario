"""
Access Scenario configuration in Python to define evaluation policies and structured agent testing behavior.

This module provides the main configuration class for customizing the behavior
of the Scenario testing framework, including execution parameters and debugging options.
"""

import os
from typing import Any, Dict, Optional, Union, ClassVar
from pydantic import BaseModel, ConfigDict, Field

from .model import ModelConfig


class ScenarioConfig(BaseModel):
    """
    Global configuration class for the Scenario testing framework.

    This class allows users to set default behavior and parameters that apply
    to all scenario executions, including the LLM model to use for simulator
    and judge agents, execution limits, and debugging options.

    Attributes:
        default_model: Default LLM model configuration for agents (can be string or ModelConfig)
        max_turns: Maximum number of conversation turns before scenario times out
        min_turns: Minimum number of turns that must run before the judge may
            volunteer a verdict (its finish_test tool is withheld on earlier
            turns). Explicit judge() steps and the final turn still deliver a
            terminal verdict. Must be a non-negative integer and must not exceed
            max_turns. Zero is valid. Unset by default.
        verbose: Whether to show detailed output during execution (True/False or verbosity level)
        cache_key: Key for caching scenario results to ensure deterministic behavior
        debug: Whether to enable debug mode with step-by-step interaction
        fetch_remote_traces: Whether the judge fetches the traces the agent
            under test reported to LangWatch for this conversation's trace ids
            and evaluates them alongside locally collected spans. Requires the
            agent adapter to forward ``AgentInput.propagation_headers`` to the
            remote agent. Off by default.
        trace_wait_timeout: Maximum seconds the judge waits at verdict time
            for remote traces to arrive and stabilize, shared across all trace
            ids. Defaults to 60 seconds. Only used when ``fetch_remote_traces``
            is enabled.
        observability: OpenTelemetry tracing configuration (span_filter, instrumentors, etc.)

    Example:
        ```
        import scenario
        from scenario import scenario_only

        # Configure globally for all scenarios
        scenario.configure(
            default_model="openai/gpt-4.1-mini",
            max_turns=15,
            observability={
                "span_filter": scenario_only,
                "instrumentors": [],
            },
        )
        ```
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    default_model: Optional[Union[str, ModelConfig]] = None
    max_turns: Optional[int] = 10
    min_turns: Optional[int] = Field(default=None, strict=True, ge=0)
    verbose: Optional[Union[bool, int]] = True
    cache_key: Optional[str] = None
    debug: Optional[bool] = False
    headless: Optional[bool] = os.getenv("SCENARIO_HEADLESS", "false").lower() not in [
        "false",
        "0",
        "",
    ]
    fetch_remote_traces: Optional[bool] = None
    trace_wait_timeout: Optional[float] = Field(default=None, gt=0)
    observability: Optional[Dict[str, Any]] = None

    default_config: ClassVar[Optional["ScenarioConfig"]] = None

    @classmethod
    def configure(
        cls,
        default_model: Optional[Union[str, ModelConfig]] = None,
        max_turns: Optional[int] = None,
        min_turns: Optional[int] = None,
        verbose: Optional[Union[bool, int]] = None,
        cache_key: Optional[str] = None,
        debug: Optional[bool] = None,
        headless: Optional[bool] = None,
        fetch_remote_traces: Optional[bool] = None,
        trace_wait_timeout: Optional[float] = None,
        observability: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Set global configuration settings for all scenario executions.

        This method allows you to configure default behavior that will be applied
        to all scenarios unless explicitly overridden in individual scenario runs.

        Args:
            default_model: Default LLM model identifier for user simulator and judge agents
            max_turns: Maximum number of conversation turns before timeout (default: 10)
            min_turns: Minimum turns guaranteed before the judge may volunteer
                a verdict (unset by default; must be a non-negative integer no
                greater than max_turns; zero is valid)
            verbose: Enable verbose output during scenario execution
            cache_key: Cache key for deterministic scenario behavior across runs
            debug: Enable debug mode for step-by-step execution with user intervention
            fetch_remote_traces: Have the judge fetch the traces the agent
                under test reported to LangWatch for this conversation and
                evaluate them alongside locally collected spans (default: False).
                Requires the agent adapter to forward
                ``AgentInput.propagation_headers`` to the remote agent.
            trace_wait_timeout: Maximum seconds the judge waits at verdict
                time for remote traces to arrive and stabilize (default: 60)
            observability: OpenTelemetry tracing configuration. Accepts:
                - span_filter: Callable filter (use scenario_only or with_custom_scopes())
                - span_processors: List of additional SpanProcessors
                - trace_exporter: Custom SpanExporter
                - instrumentors: List of OTel instrumentors (pass [] to disable auto-instrumentation)

        Example:
            ```
            import scenario
            from scenario import scenario_only

            scenario.configure(
                default_model="openai/gpt-4.1-mini",
                observability={
                    "span_filter": scenario_only,
                    "instrumentors": [],
                },
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
                min_turns=min_turns,
                verbose=verbose,
                cache_key=cache_key,
                debug=debug,
                headless=headless,
                fetch_remote_traces=fetch_remote_traces,
                trace_wait_timeout=trace_wait_timeout,
                observability=observability,
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
