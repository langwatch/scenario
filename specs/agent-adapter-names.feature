Feature: Agent adapters carry a name and runs report their agents
  As a developer who runs scenarios from code
  I want every agent adapter to carry a name and every run to report its agents
  So that LangWatch can show the real target of the run instead of "default"

  Background:
    Given a scenario that runs an agent adapter, a user simulator and a judge
    And the scenario emits a SCENARIO_RUN_STARTED event

  @unit
  Scenario: An adapter with an explicit name reports that name
    Given an agent adapter that sets name to "MyAgent"
    When the scenario run starts
    Then metadata.agents contains an entry with name "MyAgent" and role "agent"

  @unit
  Scenario: An adapter without a name reports its class name
    Given an agent adapter class "PlainAgent" that sets no name
    When the scenario run starts
    Then metadata.agents contains an entry with name "PlainAgent" and role "agent"

  @unit
  Scenario: The user simulator and the judge report their roles
    Given the scenario lists a user simulator agent and a judge agent
    When the scenario run starts
    Then metadata.agents contains an entry with role "user" for the user simulator
    And metadata.agents contains an entry with role "judge" for the judge
    And the entries keep the order in which the scenario lists the agents

  @unit
  Scenario: The agents list stays out of the reserved langwatch namespace
    Given the scenario sets metadata with a "langwatch" key
    When the scenario run starts
    Then metadata.agents is a top level key next to name and description
    And the "langwatch" key holds only the value that the user set

  @unit
  Scenario: User metadata still passes through next to the agents list
    Given the scenario sets metadata with the keys "promptId" and "environment"
    When the scenario run starts
    Then metadata carries "promptId" and "environment" unchanged
    And metadata carries the agents list as well
