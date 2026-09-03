Feature: LangWatch evaluators on scenario runs
  As a scenario test author
  I want to attach LangWatch evaluators to a scenario run from code
  So that structured references, evidence outside the transcript and deterministic checks decide the run next to the judge

  Background:
    Given a scenario with fields and evaluators passed to run
    And a LangWatch endpoint and API key configured

  @unit
  Scenario: Mapping helpers build the platform mapping shape
    When the test author uses the conversation, field, trace and value helpers
    Then each helper builds a source mapping with the source id and path the platform stores
    And the value helper builds a literal value mapping

  @unit
  Scenario: Unmapped conversation inputs are inferred by name
    Given an evaluator with the inputs input, output and contexts and no mappings
    When the mappings are inferred
    Then input maps to the first user message of the conversation
    And output maps to the last agent message of the conversation
    And contexts maps to the retrieved contexts of the trace

  @unit
  Scenario: An expected-like input is inferred to a field by its name words
    Given the scenario declares the fields golden_sql and table_schema
    And an evaluator with the inputs expected_output and expected_contexts
    When the mappings are inferred
    Then expected_output maps to the field golden_sql
    And expected_contexts maps to the field table_schema

  @unit
  Scenario: An expected-like input with several candidate fields stays unmapped
    Given the scenario declares the fields golden_sql and reference_sql
    And an evaluator with the input expected_output
    When the mappings are inferred
    Then expected_output stays unmapped

  @unit
  Scenario: A tool call source is never inferred
    Given the scenario messages contain a run_sql tool call
    And an evaluator with the input output and no mappings
    When the mappings are inferred
    Then output maps to the conversation, not to the tool call

  @unit
  Scenario: An explicit mapping wins over inference
    Given an evaluator with the input output mapped to the run_sql tool call input
    When the mappings are inferred
    Then output keeps the tool call mapping

  @unit
  Scenario: A tool call input resolves from the message tool calls
    Given the agent returned a message with a run_sql tool call and its arguments
    And an evaluator input mapped to the run_sql tool call input
    When the inputs are resolved
    Then the input holds the arguments of the last run_sql call
    And no remote trace is fetched

  @unit
  Scenario: A tool call resolves from the trace spans when the messages carry none
    Given the messages carry no tool call
    And the trace holds a tool span named run_sql with an input
    And an evaluator input mapped to the run_sql tool call input
    When the inputs are resolved
    Then the input holds the input of the tool span

  @unit
  Scenario: A missing tool call fails the evaluator with a reason
    Given the messages and the trace carry no run_sql call
    And an evaluator input mapped to the run_sql tool call input
    When the evaluators run
    Then the evaluator result has the status failed
    And the details say there is no run_sql call in the trace

  @unit
  Scenario: A blank field skips the evaluator with a reason
    Given the scenario does not set the field golden_sql
    And an evaluator input mapped to the field golden_sql
    When the evaluators run
    Then the evaluator result has the status skipped
    And the details say there is no golden_sql on this scenario
    And the evaluate endpoint is not called

  @unit
  Scenario: A required evaluator that fails fails the run
    Given a required evaluator whose evaluate response is passed false
    And the judge marked the run as successful
    When the evaluators run
    Then the run result is not successful
    And the reasoning names the evaluator and its details
    And the evaluator result has the status failed

  @unit
  Scenario: A score never gates the run
    Given a required evaluator whose evaluate response carries a score and no passed flag
    And the judge marked the run as successful
    When the evaluators run
    Then the run result stays successful
    And the evaluator result has the status scored

  @unit
  Scenario: An evaluate endpoint failure is reported as an error
    Given the evaluate endpoint answers with an error
    When the evaluators run
    Then the evaluator result has the status error
    And the details carry the error
    And the run result stays as the judge decided

  @unit
  Scenario: The evaluate call carries the resolved inputs and the trace id of the last turn
    Given a conversation whose last agent turn carries a trace id
    When the evaluators run
    Then the evaluate endpoint receives the resolved inputs as data
    And the evaluate endpoint receives the trace id of the last turn

  @unit
  Scenario: The run finished event carries the evaluations
    Given a scenario with one evaluator
    When the run finishes
    Then the run finished event results carry one evaluation with the evaluator id, name, status, required flag and details
    And the scenario result exposes the same evaluations

  @unit
  Scenario: A run without evaluators sends no evaluations
    Given a scenario with no evaluators
    When the run finishes
    Then the run finished event results carry no evaluations key
