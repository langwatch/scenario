@integration
Feature: Context window exceeded error handling
  As a scenario test author
  I want clear error messages when context limits are exceeded
  So that I can identify which agent caused the failure

  Background:
    Given a scenario with an agent that returns a large response

  @integration
  Scenario: Error identifies the agent that exceeded context
    Given a VerboseAgent that returns 200k characters
    And a JudgeAgent with a 16k context model
    When the scenario runs
    Then it should raise a context window error
    And the error message should contain "JudgeAgent"
    And the error message should mention "token" or "context"

  @integration
  Scenario: Reports are still sent when context is exceeded
    Given a VerboseAgent that returns 200k characters
    And a JudgeAgent with a 16k context model
    When the scenario runs and fails
    Then a ScenarioRunFinishedEvent should be emitted
    And the event status should be "ERROR"
    And the event reasoning should contain the error message
