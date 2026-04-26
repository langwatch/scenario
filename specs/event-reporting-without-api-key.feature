Feature: EventReporter resilient auth emission and graceful empty-key handling
  As a developer running scenarios behind a corporate proxy or with a
  programmatic LangWatch setup
  I want scenario events to authenticate via the same standard header as OTel
  So that headers are not stripped by corporate proxies that allowlist
  Authorization but drop X-Auth-Token
  And when no api_key is configured anywhere the SDK still runs cleanly

  Background:
    Given a scenario test that emits scenario events during execution

  @unit
  Scenario: POST emits Authorization: Bearer alongside X-Auth-Token
    Given EventReporter has a valid api_key
    When the EventReporter posts a scenario event
    Then the request carries both Authorization: Bearer <api_key> and X-Auth-Token: <api_key>
    And a corporate proxy that strips X-Auth-Token still authenticates the request
    And a server that prefers X-Auth-Token still authenticates the request

  @unit
  Scenario: EventReporter inherits api_key from langwatch.setup(api_key=...)
    Given LANGWATCH_API_KEY is not set in the environment
    And the user has called langwatch.setup(api_key="sk-lw-real") earlier in the process
    When EventReporter is constructed without an explicit api_key
    Then the EventReporter resolves api_key from langwatch.client.Client._api_key
    And POSTs to /api/scenario-events carry X-Auth-Token: sk-lw-real

  @unit
  Scenario: Constructor api_key still wins over both env and langwatch state
    Given langwatch.client.Client._api_key is set to "sk-lw-from-langwatch"
    And LANGWATCH_API_KEY is set to "sk-lw-from-env"
    When EventReporter is constructed with api_key="sk-lw-explicit"
    Then POSTs to /api/scenario-events carry X-Auth-Token: sk-lw-explicit

  @unit
  Scenario: Env var still wins over langwatch state when constructor api_key is None
    Given langwatch.client.Client._api_key is set to "sk-lw-from-langwatch"
    And LANGWATCH_API_KEY is set to "sk-lw-from-env"
    When EventReporter is constructed without api_key
    Then POSTs to /api/scenario-events carry X-Auth-Token: sk-lw-from-env

  @unit
  Scenario: No POST is made when api_key is unavailable everywhere
    Given LANGWATCH_API_KEY is not set in the environment
    And langwatch.client.Client._api_key is empty
    When the EventReporter handles a scenario event
    Then no HTTP request is sent to /api/scenario-events
    And no error is logged for the skipped post

  @unit
  Scenario: A single guidance warning is emitted, not one per event
    Given no api_key is available from any source
    When the EventReporter handles ten scenario events in the same process
    Then exactly one warning is logged pointing the user at LANGWATCH_API_KEY or langwatch.setup(api_key=...)
    And no warning is repeated per event

  @integration
  Scenario: Scenario test exits successfully without LangWatch credentials
    Given LANGWATCH_API_KEY is not set in the environment
    And langwatch.setup() has not been called with an api_key
    When a scenario test runs to completion
    Then the test reports its verdict to the terminal
    And the process exits with the same status as it would with credentials configured
    And no 401 lines appear in stderr
