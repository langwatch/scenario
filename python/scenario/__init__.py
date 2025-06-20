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

Advanced Usage:

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

Integration with Testing Frameworks:

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

For more examples and detailed documentation, visit: https://github.com/langwatch/scenario
"""

# First import non-dependent modules
from .types import ScenarioResult, AgentInput, AgentRole, AgentReturnTypes
from .config import ScenarioConfig

# Then import modules with dependencies
from .scenario_executor import run
from .scenario_state import ScenarioState
from .agent_adapter import AgentAdapter
from .judge_agent import JudgeAgent
from .user_simulator_agent import UserSimulatorAgent
from .cache import scenario_cache
from .script import message, user, agent, judge, proceed, succeed, fail

# Import pytest plugin components
# from .pytest_plugin import pytest_configure, scenario_reporter

configure = ScenarioConfig.configure

default_config = ScenarioConfig.default_config

cache = scenario_cache

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
    "ScenarioState",
    "AgentAdapter",
    "UserSimulatorAgent",
    "JudgeAgent",
]
__version__ = "0.1.0"
