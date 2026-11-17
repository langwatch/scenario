Feature: Test any A2A v1.0 agent from its Agent Card
  As a developer whose agent speaks the A2A v1.0 protocol
  I want to pass only the Agent Card URL to scenario
  So that I can test the agent without writing an adapter, and its spans join the scenario trace

  Background:
    Given an A2A agent that serves an Agent Card at "/.well-known/agent-card.json"
    And the card lists a JSONRPC or HTTP+JSON interface in "supportedInterfaces"

  @unit
  Scenario: The adapter reads the card on the first turn
    When the scenario calls the A2A agent for the first time
    Then the adapter fetches the Agent Card once
    And the adapter takes its name from the card name
    And the adapter sends the turn to the first supported interface of the card

  @unit
  Scenario: A card without a supported interface is refused
    Given the card lists only a GRPC interface
    When the scenario calls the A2A agent
    Then the call fails with an error that names the transports the adapter supports

  @unit
  Scenario: Every turn of one scenario run shares one contextId
    When the scenario runs two turns against the A2A agent
    Then each turn is a "SendMessage" request with the last user message as a text part
    And both requests carry the same contextId
    And a second scenario thread gets a different contextId

  @unit
  Scenario: The agent reply becomes the agent message
    When the agent answers with a message, a completed task or an input-required task
    Then the scenario receives the text parts of the reply as the agent message

  @unit
  Scenario: An expired task is dropped so the next turn starts fresh
    Given the agent answered the last turn with an input-required task
    When the agent answers the continuation with a task-not-found error
    Then the call raises an error marked as task not found
    And the next turn is sent without a taskId

  @unit
  Scenario: Other errors keep the open task for a retry
    Given the agent answered the last turn with an input-required task
    When the agent answers the continuation with a JSON-RPC internal error
    Then the next turn still continues the open task

  @unit
  Scenario: A plain HTTP 404 keeps the open task for a retry
    Given the agent answered the last turn with an input-required task
    When the HTTP+JSON agent answers the continuation with a 404 that has no TASK_NOT_FOUND detail
    Then the next turn still continues the open task

  @unit
  Scenario: A 404 body of an unexpected shape fails with the HTTP status
    Given the agent answered the last turn with an input-required task
    When the HTTP+JSON agent answers the continuation with a 404 whose error is a plain string
    Then the call fails with the HTTP 404 status and is not marked task-not-found

  @unit
  Scenario: A failed or rejected task fails the turn
    When the agent answers with a task in state "TASK_STATE_FAILED" or "TASK_STATE_REJECTED"
    Then the call raises an error that carries the task state and the status message text

  @unit
  Scenario: A JSON-RPC error fails the turn
    When the agent answers with a JSON-RPC error object
    Then the call raises an error that carries the error code and message

  @unit
  Scenario: The request carries the scenario trace context
    Given the scenario turn runs inside a span
    When the adapter sends the turn
    Then the request carries a W3C "traceparent" header with the scenario trace id
    And the request carries the "A2A-Version" header with value "1.0"
    And the client span carries "gen_ai.agent.name" from the card and the "a2a.*" attributes

  @unit
  Scenario: Auth reaches the card fetch and every request
    Given the adapter is built with a bearer token or a header mapping
    When the adapter fetches the card and sends a turn
    Then both requests carry the auth headers

  @unit
  Scenario: An A2A v0.3 Agent Card is refused with an error that names the version
    Given the card has no "supportedInterfaces" and reports protocol version 0.3 or a preferred transport
    When the scenario calls the A2A agent
    Then the call fails with an error that says the adapter speaks A2A v1.0 only
    And no message is sent

  @unit
  Scenario: The adapter skips v0.x interfaces and sends the interface tenant
    Given the card lists a v0.3 interface before a v1.0 HTTP+JSON interface with a tenant
    When the scenario calls the A2A agent
    Then the turn goes to the v1.0 interface under the tenant path and carries the tenant

  @unit
  Scenario: A result with neither a task nor a message fails the turn
    When the agent answers with a v0.3 shaped message or an empty result
    Then the call fails instead of returning an empty agent message

  @unit
  Scenario: A submitted or working task is polled until it finishes
    When the agent answers with a working task that completes on the second "GetTask"
    Then the scenario receives the text of the completed task
    And a task that stays working fails the turn after the timeout

  @unit
  Scenario: Auth stays on the card origin
    Given the card names an interface on another origin
    When the adapter sends a turn
    Then the other origin receives no auth headers unless the caller opts in
    And a card redirect to another origin is followed without the auth headers

  @unit
  Scenario: HTTP, network and body failures raise the adapter error
    When the card fetch fails with HTTP 500, the reply is a JSON array, or the host is unreachable
    Then each call raises the adapter error

  @unit
  Scenario: A name given to the adapter is the agent name from the start
    Given the adapter is built with a name
    When the scenario calls the A2A agent
    Then the adapter keeps that name before and after the card is read

  @unit
  Scenario: A turn without a new user message fails instead of resending old text
    Given the new messages of the turn hold no user message
    When the scenario calls the A2A agent
    Then the call fails with an error that asks for a user turn
    And no message is sent
