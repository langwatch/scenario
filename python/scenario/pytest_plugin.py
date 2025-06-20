"""
Pytest plugin for Scenario testing library.

This module provides pytest integration for the Scenario framework, including
automatic test reporting, debug mode support, and collection of scenario
results across test runs. It enables seamless integration with existing
pytest-based testing workflows.
"""

import pytest
from typing import TypedDict
import functools
from termcolor import colored

from scenario.config import ScenarioConfig
from scenario.types import ScenarioResult

from .scenario_executor import ScenarioExecutor


class ScenarioReporterResults(TypedDict):
    """
    Type definition for scenario test results stored by the reporter.

    Attributes:
        scenario: The ScenarioExecutor instance that ran the test
        result: The ScenarioResult containing test outcome and details
    """

    scenario: ScenarioExecutor
    result: ScenarioResult


# ScenarioReporter class definition moved outside the fixture for global use
class ScenarioReporter:
    """
    Collects and reports on scenario test results across a pytest session.

    This class automatically collects results from all scenario tests run during
    a pytest session and provides comprehensive reporting including success rates,
    timing information, and detailed failure analysis.

    The reporter is automatically instantiated by the pytest plugin and collects
    results from all scenario.run() calls without requiring explicit user setup.

    Attributes:
        results: List of all scenario test results collected during the session
    """

    def __init__(self):
        """Initialize an empty scenario reporter."""
        self.results: list[ScenarioReporterResults] = []

    def add_result(self, scenario: ScenarioExecutor, result: ScenarioResult):
        """
        Add a test result to the reporter.

        This method is called automatically by the pytest plugin whenever
        a scenario.run() call completes. It stores both the scenario
        configuration and the test result for later reporting.

        Args:
            scenario: The ScenarioExecutor instance that ran the test
            result: The ScenarioResult containing test outcome and details
        """
        self.results.append({"scenario": scenario, "result": result})

    def get_summary(self):
        """
        Get a summary of all test results.

        Calculates aggregate statistics across all scenario tests that
        have been run during the current pytest session.

        Returns:
            Dictionary containing summary statistics:
            - total: Total number of scenarios run
            - passed: Number of scenarios that passed
            - failed: Number of scenarios that failed
            - success_rate: Percentage of scenarios that passed (0-100)
        """
        total = len(self.results)
        passed = sum(1 for r in self.results if r["result"].success)
        failed = total - passed

        return {
            "total": total,
            "passed": passed,
            "failed": failed,
            "success_rate": round(passed / total * 100, 2) if total else 0,
        }

    def print_report(self):
        """
        Print a detailed report of all test results.

        Outputs a comprehensive report to the console showing:
        - Overall summary statistics
        - Individual scenario results with success/failure status
        - Detailed reasoning for each scenario outcome
        - Timing information when available
        - Criteria pass/fail breakdown for judge-evaluated scenarios

        The report is automatically printed at the end of pytest sessions,
        but can also be called manually for intermediate reporting.

        Example output:
        ```
        === Scenario Test Report ===
        Total Scenarios: 5
        Passed: 4
        Failed: 1
        Success Rate: 80%

        1. weather query test - PASSED in 2.34s (agent: 1.12s)
           Reasoning: Agent successfully provided weather information
           Passed Criteria: 2/2

        2. complex math problem - FAILED in 5.67s (agent: 3.45s)
           Reasoning: Agent provided incorrect calculation
           Failed Criteria: 1
        ```
        """
        if not self.results:
            return  # Skip report if no results

        summary = self.get_summary()

        print("\n" + colored("=== Scenario Test Report ===", "cyan", attrs=["bold"]))
        print(colored(f"Total Scenarios: {summary['total']}", "white"))
        print(
            colored(
                f"Passed: {summary['passed']}",
                "green" if summary["passed"] > 0 else "white",
            )
        )
        print(
            colored(
                f"Failed: {summary['failed']}",
                "red" if summary["failed"] > 0 else "white",
            )
        )

        # Color the success rate based on its value
        success_rate = summary["success_rate"]
        rate_color = (
            "green"
            if success_rate == 100
            else "yellow" if success_rate >= 70 else "red"
        )
        print(colored(f"Success Rate: {success_rate}%", rate_color))

        for idx, item in enumerate(self.results, 1):
            scenario = item["scenario"]
            result = item["result"]

            status = "PASSED" if result.success else "FAILED"
            status_color = "green" if result.success else "red"

            time = ""
            if result.total_time and result.agent_time:
                time = f" in {result.total_time:.2f}s (agent: {result.agent_time:.2f}s)"

            print(
                f"\n{idx}. {scenario.name} - {colored(status, status_color, attrs=['bold'])}{time}"
            )

            print(
                colored(
                    f"   Reasoning: {result.reasoning}",
                    "green" if result.success else "red",
                )
            )

            if hasattr(result, "passed_criteria") and result.passed_criteria:
                criteria_count = len(result.passed_criteria)
                total_criteria = len(result.passed_criteria) + len(
                    result.failed_criteria
                )
                criteria_color = (
                    "green" if criteria_count == total_criteria else "yellow"
                )
                print(
                    colored(
                        f"   Passed Criteria: {criteria_count}/{total_criteria}",
                        criteria_color,
                    )
                )

            if hasattr(result, "failed_criteria") and result.failed_criteria:
                print(
                    colored(
                        f"   Failed Criteria: {len(result.failed_criteria)}",
                        "red",
                    )
                )


# Store the original run method
original_run = ScenarioExecutor.run


@pytest.hookimpl(trylast=True)
def pytest_configure(config):
    """
    Configure pytest integration for Scenario testing.

    This hook is called when pytest starts and sets up:
    - Registration of the @pytest.mark.agent_test marker
    - Debug mode configuration from command line arguments
    - Global scenario reporter for collecting results
    - Automatic result collection from all scenario.run() calls

    Args:
        config: pytest configuration object

    Note:
        This function runs automatically when pytest loads the plugin.
        Users don't need to call it directly.

    Debug Mode:
        When --debug is passed to pytest, enables step-by-step scenario
        execution with user intervention capabilities.

    Example:
        ```bash
        # Enable debug mode for all scenarios
        pytest tests/ --debug -s

        # Run normally
        pytest tests/
        ```
    """
    # Register the marker
    config.addinivalue_line(
        "markers", "agent_test: mark test as an agent scenario test"
    )

    if config.getoption("--debug"):
        print(colored("\nScenario debug mode enabled (--debug).", "yellow"))
        ScenarioConfig.configure(verbose=True, debug=True)

    # Create a global reporter instance
    config._scenario_reporter = ScenarioReporter()

    # Create a patched version of Scenario.run that auto-reports
    @functools.wraps(original_run)
    async def auto_reporting_run(self, *args, **kwargs):
        result = await original_run(self, *args, **kwargs)

        # Always report to the global reporter
        # Ensure the reporter exists before adding result
        if hasattr(config, "_scenario_reporter"):
            config._scenario_reporter.add_result(self, result)
        else:
            # Handle case where reporter might not be initialized (should not happen with current setup)
            print(colored("Warning: Scenario reporter not found during run.", "yellow"))

        return result

    # Apply the patch
    ScenarioExecutor.run = auto_reporting_run


@pytest.hookimpl(trylast=True)
def pytest_unconfigure(config):
    """
    Clean up pytest integration when pytest exits.

    This hook is called when pytest is shutting down and:
    - Prints the final scenario test report
    - Restores the original ScenarioExecutor.run method
    - Cleans up any remaining resources

    Args:
        config: pytest configuration object

    Note:
        This function runs automatically when pytest exits.
        Users don't need to call it directly.
    """
    # Print the final report
    if hasattr(config, "_scenario_reporter"):
        config._scenario_reporter.print_report()

    # Restore the original method
    ScenarioExecutor.run = original_run


@pytest.fixture
def scenario_reporter(request):
    """
    Pytest fixture for accessing the global scenario reporter.

    This fixture provides access to the same reporter that's used for automatic
    reporting, allowing tests to explicitly interact with the reporter if needed.

    Args:
        request: pytest request object containing test context

    Yields:
        ScenarioReporter: The global reporter instance collecting all scenario results

    Example:
        ```
        @pytest.mark.agent_test
        def test_with_custom_reporting(scenario_reporter):
            # Run your scenarios
            result1 = await scenario.run(
                name="test 1",
                description="First test",
                agents=[agent, user_sim, judge]
            )

            result2 = await scenario.run(
                name="test 2",
                description="Second test",
                agents=[agent, user_sim, judge]
            )

            # Access collected results
            assert len(scenario_reporter.results) == 2

            # Check success rate
            summary = scenario_reporter.get_summary()
            assert summary['success_rate'] >= 90

            # Print intermediate report
            if summary['failed'] > 0:
                scenario_reporter.print_report()
        ```

    Note:
        The reporter automatically collects results from all scenario.run() calls,
        so you don't need to manually add results unless you're doing custom reporting.
    """
    # Get the global reporter from pytest config
    reporter = request.config._scenario_reporter
    yield reporter
    # No need to print report here as it's handled by pytest_unconfigure
