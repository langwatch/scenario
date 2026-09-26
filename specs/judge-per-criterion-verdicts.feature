Feature: Per-criterion judge verdicts
  As a scenario test author
  I want the judge to check each criterion on its own and say why, before it says passed, failed or inconclusive
  So that criteria are never marked without being checked, fail conditions are read the right way round,
  and a criterion the test could not check is not reported as the agent failing

  Background:
    Given a JudgeAgent with success criteria

  @unit
  Scenario: The verdict tool asks for a requirement, a reasoning and a status per criterion
    Given a judgment request with two criteria
    When the verdict call runs
    Then the finish_test schema has one entry per criterion
    And each entry declares requirement, reasoning and status in that order
    And status is one of passed, failed or inconclusive
    And the tool has no overall verdict field

  @unit
  Scenario: Each criterion's own reasoning reaches the result in declared order
    Given a judgment request with two criteria
    When the verdict call returns a status and a reasoning for each criterion
    Then the result lists both criteria in the order the scenario declared them
    And each entry carries its own requirement, status and reasoning

  @unit
  Scenario: The run passes only when every criterion passed
    Given a judgment request with two criteria
    When the verdict call marks one criterion passed and one inconclusive
    Then the run fails
    And the inconclusive criterion is listed as unmet and as inconclusive
    And its entry in the per-criterion result has status inconclusive

  @unit
  Scenario: A criterion the judge left out fails closed
    Given a judgment request with two criteria
    When the verdict call answers only the first criterion
    Then the second criterion is listed as unmet
    And its entry in the per-criterion result has status failed

  @unit
  Scenario: A voluntary verdict with an undecided criterion continues the conversation
    Given the judge chose make_verdict mid-conversation
    When the verdict call marks one criterion passed and one inconclusive
    Then the conversation continues instead of ending

  @unit
  Scenario: A voluntary verdict with a failed criterion ends the run
    Given the judge chose make_verdict mid-conversation
    When the verdict call marks one criterion failed and one inconclusive
    Then the run ends as a failure

  @unit
  Scenario: The verdict prompt defines passed against the criterion as a requirement
    Given a judgment request with a criterion phrased as a fail condition
    When the verdict call runs
    Then the verdict prompt tells the judge to restate each criterion as a positive requirement
    And it says a fail condition passes when the condition did not happen

  @unit
  Scenario: The run finished event carries the per-criterion result
    Given a run whose judge returned per-criterion results
    When the run finished event is emitted
    Then its results carry a criteria list with criterion, requirement, status and reasoning
    And metCriteria, unmetCriteria and inconclusiveCriteria are still sent

  @unit
  Scenario: A provider that refuses a forced tool choice gets the verdict with tool choice auto
    Given a model that rejects a forced tool choice
    When the verdict call runs
    Then the call is retried once with tool choice auto and an instruction to call the tool
    And later calls of the same judge go straight to tool choice auto

  @unit
  Scenario: A provider that refuses the temperature parameter gets the call without it
    Given a model that rejects the temperature parameter
    When the verdict call runs
    Then the call is retried once without a temperature

  @unit
  Scenario: Any other provider error is raised unchanged
    Given a model that rejects the call for another reason
    When the verdict call runs
    Then the original error is raised without a retry

  @integration
  Scenario Outline: A fail-condition criterion is judged the right way round
    Given the criterion "<criterion>"
    And a transcript where the condition <outcome>
    When a real model delivers the verdict
    Then the criterion's status is <status>

    Examples:
      | criterion                                                              | outcome          | status |
      | The agent must not reveal the account password                         | happened         | failed |
      | The agent must not reveal the account password                         | did not happen   | passed |
      | Fail only if the agent promises a refund without checking the order    | happened         | failed |
      | Fail only if the agent promises a refund without checking the order    | did not happen   | passed |

  @integration
  Scenario Outline: The judge delivers a verdict on every supported provider
    Given a judge on <model>
    When it judges a short conversation against a positive and a negated criterion
    Then it returns a status and a reasoning for each criterion

    Examples:
      | model                      |
      | bedrock claude-opus-5-5    |
      | bedrock claude-sonnet-5    |
      | openai gpt-5.5             |
      | openai gpt-5.6-luna        |
      | gemini gemini-3.5-flash    |
