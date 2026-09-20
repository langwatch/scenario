Feature: The user simulator retries an empty model answer
  As a scenario test author
  I want a model that answers nothing to be asked again before the run fails
  So that one empty completion does not end a conversation that was fine

  Background:
    Given a user simulator agent whose model is stubbed

  @unit
  Scenario: An empty model answer is retried before the run fails
    Given the model answers with empty text once and then with a real message
    When the simulator produces the user's turn
    Then the model was called twice
    And the turn carries the message from the second answer

  @unit
  Scenario: A third empty answer still fails the turn with the empty-response message
    Given the model answers with empty text every time
    When the simulator produces the user's turn
    Then the model was called three times
    And the turn fails with "No response content from LLM"
