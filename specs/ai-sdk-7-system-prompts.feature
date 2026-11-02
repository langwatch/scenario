Feature: Testing agents send their system prompts the AI SDK 7 way
  As a scenario test author on AI SDK 7
  I want the judge and the user simulator to pass their system prompts as instructions
  So that AI SDK 7 does not refuse their calls for carrying system messages

  @unit
  Scenario: The user simulator sends its system prompt as instructions
    Given a user simulator agent whose model is stubbed
    When the simulator produces the user's turn
    Then the model call carries the system prompt as instructions
    And no message in the model call has the system role

  @unit
  Scenario: A system turn added by the script still reaches the user simulator
    Given a user simulator agent whose model is stubbed
    And the transcript holds a system turn added by the script
    When the simulator produces the user's turn
    Then the model call allows system messages
    And the scripted system turn is among the messages

  @unit
  Scenario: The judge sends its system prompt as instructions
    Given a judge agent whose model is stubbed
    When the judge decides whether to continue
    Then the model call carries the system prompt as instructions
    And no message in the model call has the system role
