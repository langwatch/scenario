@integration
Feature: Event delivery reliability
  As a scenario test author
  I want the SCENARIO_RUN_FINISHED event to reach LangWatch on every run exit
  So that failed runs never show as stuck or missing in the UI

  Background:
    Given a scenario with a configured event reporter

  @integration
  Scenario: Finished event is posted when a script assertion fails
    Given a script step that raises an assertion error
    When the scenario runs with arun and fails
    Then the assertion error propagates to the caller
    And a SCENARIO_RUN_FINISHED event with status "ERROR" is posted exactly once

  @integration
  Scenario: Finished event is still posted exactly once when building it fails
    Given a script step that raises an assertion error
    And the first attempt to build the finished event raises an exception
    When the scenario runs with arun and fails
    Then the original assertion error propagates to the caller
    And a SCENARIO_RUN_FINISHED event is posted exactly once

  @integration
  Scenario: Finished event is posted on the threaded run path
    Given a script step that raises an assertion error
    When the scenario runs with the threaded run entry point
    Then the assertion error propagates to the caller
    And a SCENARIO_RUN_FINISHED event reaches the reporter before run returns

  @integration
  Scenario: Transient transport failures are retried
    Given an event endpoint that fails twice and then succeeds
    When an event is published to the event bus
    Then the event is delivered on the third attempt

  @integration
  Scenario: A permanently failing endpoint never fails the scenario run
    Given an event endpoint that always fails
    When an event is published to the event bus and the bus drains
    Then the event is dropped with a warning after the retry limit
    And the drain returns without raising

  @integration
  Scenario: Drain never deadlocks when the worker exits as an event is enqueued
    Given the event stream completes while an event is being enqueued
    When the bus drains
    Then the drain returns and the event is delivered

  @integration
  Scenario: A drained bus can be reused
    Given a bus that already delivered an event and drained
    When a new event stream is subscribed and a second event is published
    Then the second event is delivered after the second drain
