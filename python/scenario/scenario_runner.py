"""
Scenario runner module containing the high-level API for running scenario tests.

This module provides the main entry point for executing scenario tests through
the run() function, which creates and executes ScenarioExecutor instances.
"""

from typing import List, Optional, Union
import asyncio
import concurrent.futures

from .scenario_executor import ScenarioExecutor
from .agent_adapter import AgentAdapter
from .types import ScenarioResult, ScriptStep


async def run(
    name: str,
    description: str,
    agents: List[AgentAdapter] = [],
    max_turns: Optional[int] = None,
    verbose: Optional[Union[bool, int]] = None,
    cache_key: Optional[str] = None,
    debug: Optional[bool] = None,
    script: Optional[List[ScriptStep]] = None,
) -> ScenarioResult:
    """
    High-level interface for running a scenario test.

    This is the main entry point for executing scenario tests. It creates a
    ScenarioExecutor instance and runs it in an isolated thread pool to support
    parallel execution and prevent blocking.

    Args:
        name: Human-readable name for the scenario
        description: Detailed description of what the scenario tests
        agents: List of agent adapters (agent under test, user simulator, judge)
        max_turns: Maximum conversation turns before timeout (default: 10)
        verbose: Show detailed output during execution
        cache_key: Cache key for deterministic behavior
        debug: Enable debug mode for step-by-step execution
        script: Optional script steps to control scenario flow

    Returns:
        ScenarioResult containing the test outcome, conversation history,
        success/failure status, and detailed reasoning

    Example:
        ```
        import scenario

        # Simple scenario with automatic flow
        result = await scenario.run(
           name="help request",
           description="User asks for help with a technical problem",
           agents=[
               my_agent,
               scenario.UserSimulatorAgent(),
               scenario.JudgeAgent(criteria=["Agent provides helpful response"])
           ]
        )

        # Scripted scenario with custom evaluations
        result = await scenario.run(
           name="custom interaction",
           description="Test specific conversation flow",
           agents=[
               my_agent,
               scenario.UserSimulatorAgent(),
               scenario.JudgeAgent(criteria=["Agent provides helpful response"])
           ],
           script=[
               scenario.user("Hello"),
               scenario.agent(),
               custom_eval,
               scenario.succeed()
           ]
        )

        # Results analysis
        print(f"Test {'PASSED' if result.success else 'FAILED'}")
        print(f"Reasoning: {result.reasoning}")
        print(f"Conversation had {len(result.messages)} messages")
        ```

    Note:
        - Runs in isolated thread pool to support parallel execution
        - Blocks until scenario completes or times out
        - All agent calls are automatically cached when cache_key is set
        - Exception handling ensures clean resource cleanup
    """
    scenario = ScenarioExecutor(
        name=name,
        description=description,
        agents=agents,
        max_turns=max_turns,
        verbose=verbose,
        cache_key=cache_key,
        debug=debug,
        script=script,
    )

    # We'll use a thread pool to run the execution logic, we
    # require a separate thread because even though asyncio is
    # being used throughout, any user code on the callback can
    # be blocking, preventing them from running scenarios in parallel
    with concurrent.futures.ThreadPoolExecutor() as executor:

        def run_in_thread():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            try:
                return loop.run_until_complete(scenario.run())
            finally:
                scenario.event_bus.drain()
                loop.close()

        # Run the function in the thread pool and await its result
        # This converts the thread's execution into a Future that the current
        # event loop can await without blocking
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(executor, run_in_thread)
        return result 