Feature: LangWatch evaluators on scenario runs
  As a scenario test author
  I want to attach LangWatch evaluators to a scenario run from code
  So that structured references, evidence outside the transcript and deterministic checks decide the run next to the judge

  Background:
    Given a scenario with fields and evaluators passed to run
    And a LangWatch endpoint and API key configured

  # Mappings are functions of the scenario state

  @unit
  Scenario: A mapping is a function of the scenario state
    Given an evaluator input mapped to a function of the state
    When the inputs are resolved
    Then the function receives the same state object a script step receives
    And the input holds what the function returned

  @unit
  Scenario: An async mapping is awaited
    Given an evaluator input mapped to an async function of the state
    When the inputs are resolved
    Then the input holds the value the promise resolved to

  @unit
  Scenario: A literal mapping is a constant
    Given an evaluator input mapped to a string, a number or a boolean
    When the inputs are resolved
    Then the input holds that literal

  @unit
  Scenario: The declarative helpers are state callables
    When the test author uses the conversation, scenario source, field, trace and value helpers
    Then each helper is a function of the state
    And each helper carries the expression it stands for
    And calling the helper with a state gives the same value as the expression

  @unit
  Scenario: A tool call pick names the call with first or last
    Given the agent called run_sql twice
    When the mapping reads the last run_sql call input
    Then the input holds the arguments of the second call
    When the mapping reads the first run_sql call input
    Then the input holds the arguments of the first call

  @unit
  Scenario: A turn narrows the tool calls
    Given the agent called run_sql in the first turn and again in the second
    When the mapping reads the run_sql calls of the second turn
    Then only the call of the second turn is listed

  # Inference by input name

  @unit
  Scenario: Unmapped conversation inputs are inferred by name
    Given an evaluator with the inputs input, output and contexts and no mappings
    When the mappings are inferred
    Then input reads the first user message of the state
    And output reads the last agent message of the state
    And contexts reads the retrieved contexts of the state

  @unit
  Scenario: An expected-like input is inferred to a field by its name words
    Given the scenario declares the fields golden_sql and table_schema
    And an evaluator with the inputs expected_output and expected_contexts
    When the mappings are inferred
    Then expected_output reads the field golden_sql
    And expected_contexts reads the field table_schema

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
    Then output reads the last agent message, not the tool call

  @unit
  Scenario: An explicit mapping wins over inference
    Given an evaluator with the input output mapped to a function of the state
    When the mappings are inferred
    Then output keeps that function

  # Resolution outcomes

  @unit
  Scenario: A tool call input resolves from the message tool calls
    Given the agent returned a message with a run_sql tool call and its arguments
    And an evaluator input mapped to the last run_sql call input
    When the inputs are resolved
    Then the input holds the arguments of the last run_sql call
    And no remote trace is fetched

  @unit
  Scenario: A tool call resolves from the trace spans when the messages carry none
    Given the messages carry no tool call
    And the trace holds a tool span named run_sql with an input
    And an evaluator input mapped to the last run_sql call input
    When the inputs are resolved
    Then the input holds the input of the tool span

  @unit
  Scenario: A mapping that returns nothing skips the evaluator
    Given an evaluator input mapped to a function that returns nothing
    When the evaluators run
    Then the evaluator result has the status skipped
    And the details say the mapping returned nothing
    And the evaluate endpoint is not called

  @unit
  Scenario: A blank field skips the evaluator with the field name
    Given the scenario does not set the field golden_sql
    And an evaluator input mapped to the field golden_sql
    When the evaluators run
    Then the evaluator result has the status skipped
    And the details say there is no golden_sql on this scenario
    And the evaluate endpoint is not called

  @unit
  Scenario: A missing tool call skips the evaluator with the tool name
    Given the messages and the trace carry no run_sql call
    And an evaluator input mapped to the last run_sql call input
    When the evaluators run
    Then the evaluator result has the status skipped
    And the details say there is no run_sql call in the trace

  @unit
  Scenario: A mapping that raises errors the evaluator
    Given an evaluator input mapped to a function that raises
    When the evaluators run
    Then the evaluator result has the status error
    And the details carry the error message
    And the evaluate endpoint is not called

  @unit
  Scenario: A mapping that read the trace and found nothing fetches the remote traces once
    Given the messages carry trace ids and no run_sql call
    And the local spans hold no run_sql tool span
    And two evaluator inputs mapped to the last run_sql call input
    When the evaluators run
    Then the remote traces of the run are fetched once
    And every mapping is called again after the fetch

  @unit
  Scenario: A mapping that did not read the trace never fetches the remote traces
    Given an evaluator input mapped to a function that returns nothing without reading the trace
    When the evaluators run
    Then no remote trace is fetched

  @unit
  Scenario: A saved evaluator declares its own inputs
    Given a saved evaluator whose record declares the fields output (required) and contexts (optional) and the output passed
    When the evaluator spec is loaded
    Then the spec lists output as required and contexts as optional
    And the spec says the evaluator answers pass or fail

  @unit
  Scenario: The evaluations API never follows a redirect with the key
    Given the evaluations endpoint answers with a redirect
    When the catalogue or the evaluate call is requested
    Then the request refuses the redirect instead of forwarding the API key

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

  # Events

  @unit
  Scenario: The run started event carries the fields
    Given a scenario with the field golden_sql
    When the run starts
    Then the run started event metadata carries the fields

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
