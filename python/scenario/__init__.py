"""
Scenario: Agent Testing Framework through Simulation Testing

Scenario is a comprehensive testing framework for AI agents that uses simulation testing
to validate agent behavior through realistic conversations. It enables testing of both
happy paths and edge cases by simulating user interactions and evaluating agent responses
against configurable success criteria.

Key Features:
- End-to-end conversation testing with specified scenarios
- Flexible control from fully scripted to completely automated simulations
- Multi-turn evaluation designed for complex conversational agents
- Works with any testing framework (pytest, unittest, etc.)
- Framework-agnostic integration with any LLM or agent architecture
- Built-in caching for deterministic and faster test execution

Basic Usage:
    ```python
    import scenario

    # Configure global settings
    scenario.configure(default_model="openai/gpt-4.1-mini")

    # Create your agent adapter
    class MyAgent(scenario.AgentAdapter):
        async def call(self, input: scenario.AgentInput) -> scenario.AgentReturnTypes:
            return my_agent_function(input.last_new_user_message_str())

    # Run a scenario test
    result = await scenario.run(
        name="customer service test",
        description="Customer asks about billing, agent should help politely",
        agents=[
            MyAgent(),
            scenario.UserSimulatorAgent(),
            scenario.JudgeAgent(criteria=[
                "Agent is polite and professional",
                "Agent addresses the billing question",
                "Agent provides clear next steps"
            ])
        ]
    )

    assert result.success
    ```

Advanced Usage:
    ```python
    # Script-controlled scenario with custom evaluations
    def check_tool_usage(state: scenario.ScenarioState) -> None:
        assert state.has_tool_call("get_customer_info")

    result = await scenario.run(
        name="scripted interaction",
        description="Test specific conversation flow",
        agents=[
            MyAgent(),
            scenario.UserSimulatorAgent(),
            scenario.JudgeAgent(criteria=["Agent provides helpful response"])
        ],
        script=[
            scenario.user("I have a billing question"),
            scenario.agent(),
            check_tool_usage,  # Custom assertion
            scenario.proceed(turns=2),  # Let it continue automatically
            scenario.succeed("All requirements met")
        ]
    )
    ```

Integration with Testing Frameworks:
    ```python
    import pytest

    @pytest.mark.agent_test
    @pytest.mark.asyncio
    async def test_weather_agent():
        result = await scenario.run(
            name="weather query",
            description="User asks about weather in a specific city",
            agents=[
                WeatherAgent(),
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent(criteria=["Provides accurate weather information"])
            ]
        )
        assert result.success
    ```

For more examples and detailed documentation, visit: https://github.com/langwatch/scenario
"""

# First import non-dependent modules
from .types import ScenarioResult, AgentInput, AgentRole, AgentReturnTypes
from .config import ScenarioConfig

# Then import modules with dependencies
from .scenario_executor import ScenarioExecutor
from .scenario_state import ScenarioState
from .agent_adapter import AgentAdapter
from .judge_agent import JudgeAgent
from .user_simulator_agent import UserSimulatorAgent
from .cache import scenario_cache
from .script import message, user, agent, judge, proceed, succeed, fail

# Import pytest plugin components
from .pytest_plugin import pytest_configure, scenario_reporter

run = ScenarioExecutor.run
"""
High-level interface for running scenario tests.

This is the main entry point for executing scenario-based agent tests. It creates
and runs a complete scenario simulation including user interactions, agent responses,
and success evaluation.

Args:
    name: Human-readable name for the scenario
    description: Detailed description that guides the simulation behavior
    agents: List of agent adapters (agent under test, user simulator, judge)
    max_turns: Maximum conversation turns before timeout (default: 10)
    verbose: Show detailed output during execution
    cache_key: Cache key for deterministic behavior across runs
    debug: Enable debug mode for step-by-step execution
    script: Optional script steps to control scenario flow

Returns:
    ScenarioResult containing test outcome, conversation history, and detailed analysis

Example:
    ```python
    result = await scenario.run(
        name="help request",
        description="User needs help with a technical problem",
        agents=[
            MyAgentAdapter(),
            scenario.UserSimulatorAgent(),
            scenario.JudgeAgent(criteria=["Provides helpful response"])
        ]
    )

    print(f"Test {'PASSED' if result.success else 'FAILED'}")
    print(f"Reasoning: {result.reasoning}")
    ```
"""

configure = ScenarioConfig.configure
"""
Set global configuration settings for all scenario executions.

This function allows you to configure default behavior that will be applied
to all scenarios unless explicitly overridden in individual scenario runs.

Args:
    default_model: Default LLM model identifier for user simulator and judge agents
    max_turns: Maximum number of conversation turns before timeout (default: 10)
    verbose: Enable verbose output during scenario execution
    cache_key: Cache key for deterministic scenario behavior across runs
    debug: Enable debug mode for step-by-step execution with user intervention

Example:
    ```python
    # Set up global defaults
    scenario.configure(
        default_model="openai/gpt-4.1-mini",
        max_turns=15,
        verbose=True,
        cache_key="my-test-suite-v1"
    )

    # All subsequent scenarios will use these defaults
    result = await scenario.run(...)
    ```
"""

default_config = ScenarioConfig.default_config
"""
Access to the current global configuration settings.

This provides read-only access to the default configuration that has been
set via scenario.configure(). Useful for debugging or conditional logic
based on current settings.

Example:
    ```python
    if scenario.default_config and scenario.default_config.debug:
        print("Debug mode is enabled")
    ```
"""

cache = scenario_cache
"""
Decorator for caching function calls during scenario execution.

This decorator enables deterministic testing by caching LLM calls and other
non-deterministic operations based on scenario configuration and function arguments.
Results are cached when a cache_key is configured, making tests repeatable and faster.

Args:
    ignore: List of argument names to exclude from cache key computation

Example:
    ```python
    class MyAgent:
        @scenario.cache(ignore=["self"])
        def invoke(self, message: str) -> str:
            # This LLM call will be cached when cache_key is set
            return llm_client.complete(model="gpt-4", prompt=message)

    # Enable caching for deterministic tests
    scenario.configure(cache_key="test-suite-v1")
    ```
"""

__all__ = [
    # Functions
    "run",
    "configure",
    "default_config",
    "cache",

    # Script
    "message",
    "proceed",
    "succeed",
    "fail",
    "judge",
    "agent",
    "user",

    # Types
    "ScenarioResult",
    "AgentInput",
    "AgentRole",
    "ScenarioConfig",
    "AgentReturnTypes",

    # Classes
    "ScenarioExecutor",
    "ScenarioState",
    "AgentAdapter",
    "UserSimulatorAgent",
    "JudgeAgent",

    # Plugins
    "pytest_configure",
    "scenario_reporter",
    "scenario_cache",
]
__version__ = "0.1.0"