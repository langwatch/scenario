Feature: scenario.run accepts a connected agent function
  As a developer who connected an agent to LangWatch with the SDK decorator
  I want to pass that decorated function straight to scenario.run
  So that the local test and the platform run share one piece of code for the agent

  Background:
    Given a function decorated with the LangWatch connect agent decorator
    And the decorated object is callable and exposes the connected agent shape

  @unit
  Scenario: The decorated function is accepted as an agent without an adapter subclass
    Given a scenario with the decorated function in its agents list
    When the scenario resolves its agents
    Then the decorated function is wrapped into an agent adapter with the AGENT role
    And an agent adapter in the same list is passed through unchanged

  @unit
  Scenario: The wrapper builds the connected call from the scenario input
    Given the scenario calls the wrapped agent with messages, new messages and a thread id
    When the wrapper invokes the decorated function
    Then the function receives the full messages and the new messages
    And the function receives the scenario thread id
    And the function receives the trace id of the current turn
    And the session is null on the first turn of a thread

  @unit
  Scenario: A string reply becomes the agent's message
    When the decorated function returns a string
    Then the scenario receives that string

  @unit
  Scenario: A single message reply is returned as is
    When the decorated function returns one message
    Then the scenario receives that message

  @unit
  Scenario: A list of messages reply is returned as is
    When the decorated function returns a list of messages
    Then the scenario receives that list

  @unit
  Scenario: An output with session reply is unwrapped
    When the decorated function returns an output with a session
    Then the scenario receives the output alone

  @unit
  Scenario: The session from one turn arrives on the next turn of the same thread
    Given the decorated function returned a session on the first turn of a thread
    When the wrapper invokes the decorated function for the second turn of that thread
    Then the function receives that session
    And a turn on another thread receives no session

  @unit
  Scenario: A reply without a session keeps the session of the thread
    Given the decorated function returned a session on the first turn of a thread
    And it returned a string on the second turn
    When the wrapper invokes the decorated function for the third turn
    Then the function still receives the session from the first turn

  @unit
  Scenario: Run parameters from the scenario reach the function
    Given a scenario that sets a run parameter
    When the wrapper invokes the decorated function
    Then the function receives that parameter value

  @unit
  Scenario: A run parameter the scenario does not set takes the function default
    Given a scenario that sets no run parameter
    When the wrapper invokes the decorated function
    Then the function receives no parameter and uses its own default

  @unit
  Scenario: A run reports the connected agent under the name of the function
    Given a scenario with the decorated function in its agents list
    When the scenario run starts
    Then the run reports the agent under the name the decorator gave the function
    And it does not report the name of the wrapper class
    And both SDKs report the same name for the same function
