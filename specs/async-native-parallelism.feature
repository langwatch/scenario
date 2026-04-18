Feature: Async-native parallelism for scenario runs
  As a scenario test author whose adapter relies on loop-bound async state
  I want scenarios to execute on my own event loop instead of a private thread-loop
  So that my async fixtures and objects survive concurrent scenario runs without "Future attached to a different loop"

  Background:
    Given an async-native AgentAdapter implementation

  # --- Loop affinity ---

  @unit
  Scenario: Async adapter executes on the caller's event loop
    Given a scenario.arun() call issued from an existing event loop
    When the agent adapter awaits on a resource created in that same loop
    Then the resource is awaited successfully
    And no "Future attached to a different loop" error is raised

  @unit
  Scenario: Loop-bound singleton survives concurrent scenario runs
    Given a resource created once outside the scenario and bound to the caller's loop
    When several scenarios are executed concurrently through scenario.arun()
    Then every run reuses the same singleton
    And no loop-affinity error is raised on any run

  @unit
  Scenario: scenario.run() keeps its private thread-loop behaviour
    Given an adapter whose body is fully self-contained with no loop-bound dependencies
    When it is executed through scenario.run()
    Then it still runs inside a dedicated worker thread and private event loop
    And existing test suites relying on that behaviour continue to pass

  # --- Concurrency correctness ---

  @unit
  Scenario: Concurrent runs produce isolated results
    Given two scenarios launched through scenario.arun() on the same loop
    When both complete successfully
    Then each scenario returns its own result object
    And neither result contains messages from the other scenario

  @unit
  Scenario: A failing concurrent run does not abort siblings
    Given three scenarios launched through scenario.arun() where one raises mid-run
    When the gather completes
    Then the two sibling scenarios still produce their results
    And the failing scenario surfaces its error to the caller

  # --- Telemetry ---

  @integration
  Scenario: Each concurrent scenario owns its own OTel trace
    Given several scenarios running concurrently through scenario.arun()
    When spans are exported
    Then every scenario's spans share a single root trace id unique to that scenario
    And no span from one scenario is parented under another scenario's span

  @integration
  Scenario: Agent spans are parented under their scenario turn
    Given a running scenario where an instrumented agent emits spans
    When the scenario turn completes
    Then every agent span parents up to the "Scenario Turn" root of that run

  # --- End-to-end ---

  @e2e
  Scenario: Shared async singleton used by many scenarios concurrently
    Given a long-lived async singleton created in a pytest fixture on the caller's loop
    And multiple scenarios whose adapter awaits on that singleton
    When they are executed concurrently through scenario.arun()
    Then all runs complete without loop-affinity errors
    And each run appears as a distinct trace in ClickHouse
    And cost and token counts roll up correctly per scenario
