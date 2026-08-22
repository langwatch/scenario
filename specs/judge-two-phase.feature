Feature: Two-phase judge: decision gate then verdict
  As a scenario test author
  I want the judge to separate "should the conversation continue" from the verdict itself
  So that conversations play out naturally and every verdict is made with the full evidence

  Background:
    Given a JudgeAgent with success criteria

  @unit
  Scenario: A mid-conversation judge call decides between continuing and judging with argument-free tools
    Given the judge is called mid-conversation without an explicit judgment request
    When the decision call runs
    Then the judge's terminal tools are continue_test and make_verdict
    And neither decision tool accepts any arguments
    And finish_test is not offered

  @unit
  Scenario: A make_verdict decision leads to exactly one verdict call
    Given the judge decides mid-conversation that enough information has been collected
    When the decision call returns make_verdict
    Then one verdict call follows with the tool choice pinned to finish_test
    And the run result comes from the verdict call

  @unit
  Scenario: A continue decision makes no verdict call
    Given the judge is called mid-conversation
    When the decision call returns continue_test
    Then no verdict call is made
    And the conversation continues

  @unit
  Scenario: An explicit judgment request goes straight to the verdict call
    Given a judgment request with criteria
    When the judge is called
    Then the first and only LLM call is the verdict call
    And finish_test is the only terminal tool offered

  @unit
  Scenario: The last turn goes straight to the verdict call
    Given the conversation reached its final turn
    When the judge is called
    Then the first and only LLM call is the verdict call

  @unit
  Scenario: A voluntary verdict of inconclusive continues the conversation
    Given the judge chose make_verdict mid-conversation
    When the verdict call returns an inconclusive verdict
    Then the conversation continues instead of ending

  @unit
  Scenario: A required verdict of inconclusive is terminal
    Given the conversation reached its final turn
    When the verdict call returns an inconclusive verdict
    Then the run ends with that verdict

  @unit
  Scenario: Below the min_turns floor the judge continues without any LLM call
    Given a scenario with min_turns above the current turn
    When the judge is called without an explicit judgment request
    Then the judge continues without any LLM call

  @unit
  Scenario: Decision discovery exhaustion forces a terminal verdict
    Given a large trace puts the decision call into discovery mode
    When the decision loop exhausts its steps without a decision
    Then a verdict call follows
    And its verdict is terminal even when inconclusive

  @unit
  Scenario: The decision prompt defers judgment and leans towards continuing
    Given the decision call is being prepared
    When the system prompt is built
    Then it instructs the judge not to decide pass or fail yet
    And it instructs the judge to lean towards continuing while the conversation is short
