@python
Feature: Expose JudgmentRequest.context on the public scenario.judge() API
  As a scenario test author
  I want to pass additional context to the judge via scenario.judge(additional_context=...)
  So that the judge can ground its evaluation in reference material without replacing the default judge system prompt

  Background:
    Given a JudgeAgent with configured criteria
    And a mocked litellm completion that returns a finish_test verdict

  @unit
  Scenario: context string forwarded to judge LLM input (AC1)
    Given ScenarioExecutor.judge is called with additional_context="the agent ran npm install which exited 0"
    When the judge LLM is invoked
    Then the user message sent to litellm contains an <additional_context> block
    And the user message contains "the agent ran npm install which exited 0" inside that block

  @unit
  Scenario: criteria and context forwarded independently (AC2)
    Given ScenarioExecutor.judge is called with criteria=["agent installed dependency"] and additional_context="exit code 0"
    When the judge LLM is invoked
    Then the judge evaluates against criteria ["agent installed dependency"]
    And the user message contains an <additional_context> block with "exit code 0"

  @unit
  Scenario: no context produces no additional_context block — no arguments (AC3)
    Given ScenarioExecutor.judge is called with no arguments
    When the judge LLM is invoked
    Then the user message sent to litellm does not contain an <additional_context> block

  @unit
  Scenario: no context produces no additional_context block — criteria only (AC3)
    Given ScenarioExecutor.judge is called with criteria=["agent responded"] and no context
    When the judge LLM is invoked
    Then the user message sent to litellm does not contain an <additional_context> block

  @unit
  Scenario: empty string context produces no additional_context block (AC5)
    Given ScenarioExecutor.judge is called with additional_context=""
    When the judge LLM is invoked
    Then the user message sent to litellm does not contain an <additional_context> block

  @unit
  Scenario: additional_context parameter documented in script.py judge() docstring (AC4)
    Given the file python/scenario/script.py
    When the judge() function docstring is inspected
    Then it contains the phrase "Additional context for the judge"

  @unit
  Scenario: existing judge() calls without context unchanged (AC6)
    Given ScenarioExecutor.judge is called with criteria=["agent responded"] as it was before this change
    When the judge LLM is invoked
    Then the verdict and criteria evaluation behave identically to the pre-change behavior
    And the user message does not contain an <additional_context> block

  @unit
  Scenario: JudgeAgent.call() consumer-level tests remain green (AC7)
    Given the existing test_judge_includes_additional_context_in_prompt test
    And the existing test_judge_omits_additional_context_when_none test
    When those tests run against the modified codebase
    Then both pass without modification

# --- AC Coverage Map ---
# AC1: "ScenarioExecutor.judge(additional_context='<ctx>') results in '<ctx>' appearing inside <additional_context>"
#   → Scenario: context string forwarded to judge LLM input (AC1)
# AC2: "ScenarioExecutor.judge(criteria=['c1'], additional_context='<ctx>') forwards both independently"
#   → Scenario: criteria and context forwarded independently (AC2)
# AC3: "ScenarioExecutor.judge() and ScenarioExecutor.judge(criteria=['c1']) produce no <additional_context> block"
#   → Scenario: no context produces no additional_context block — no arguments (AC3)
#   → Scenario: no context produces no additional_context block — criteria only (AC3)
# AC4: "additional_context param documented in script.py:judge() docstring"
#   → Scenario: context parameter documented in script.py judge() docstring (AC4)
# AC5: "scenario.judge(additional_context='') produces no <additional_context> block"
#   → Scenario: empty string context produces no additional_context block (AC5)
# AC6 (regression): "all existing scenario.judge() and scenario.judge(criteria=[...]) calls unchanged"
#   → Scenario: existing judge() calls without context unchanged (AC6)
# AC7 (consumer regression): "existing test_judge_*_additional_context_* tests pass unchanged"
#   → Scenario: JudgeAgent.call() consumer-level tests remain green (AC7)
