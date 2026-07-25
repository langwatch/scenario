Feature: Reuse a single browser tab for scenario runs
  As a developer running scenario suites repeatedly, often from a coding agent
  in the background
  I want every run to land in the same LangWatch tab I already have open
  So that a morning of iteration leaves me with one tab instead of twenty

  Background:
    Given the SDK is configured with a LangWatch API key
    And the LangWatch instance supports the browser-tab handoff endpoint

  # ---------------------------------------------------------------------------
  # The happy path: one tab, forever
  # ---------------------------------------------------------------------------

  @integration
  Scenario: The first run opens a tab because nothing is listening yet
    Given no LangWatch simulations tab is open on this machine
    When a scenario run starts
    Then the SDK asks LangWatch to hand the run to an already-open tab
    And LangWatch answers that no tab is listening
    And the SDK opens the batch URL in the default browser
    And the opened URL carries this machine's scenario tab key as a query param

  @integration
  Scenario: Later runs are handed to the tab that is already open
    Given a LangWatch simulations tab is open and registered for this machine
    When a scenario run starts
    Then LangWatch answers that the run was delivered to an open tab
    And the SDK does not open the default browser
    And the console still prints the follow-it-live URL

  @integration
  Scenario: The already-open tab moves itself to the new run
    Given a LangWatch simulations tab is open and registered for this machine
    When a scenario run starts and LangWatch delivers the handoff
    Then the open tab navigates to the new batch URL without a page reload
    And the tab does not steal focus from whatever the user is doing

  @integration
  Scenario: Closing the tab restores the auto-open behaviour
    Given a LangWatch simulations tab was open and registered for this machine
    When the user closes that tab
    And a scenario run starts after the registration has expired
    Then LangWatch answers that no tab is listening
    And the SDK opens a fresh browser tab

  # ---------------------------------------------------------------------------
  # Machine scoping — never touch someone else's browser
  # ---------------------------------------------------------------------------

  @unit
  Scenario: The scenario tab key is stable across processes on one machine
    Given the scenario tab key file does not exist yet
    When two separate SDK processes each resolve the scenario tab key
    Then both processes read the same key
    And the key is persisted under the user's LangWatch state directory

  @unit
  Scenario: Python and TypeScript SDKs share one scenario tab key
    Given a scenario tab key was created by the Python SDK
    When the TypeScript SDK resolves the scenario tab key on the same machine
    Then it reads the identical key from the same file
    And a run started from either SDK reuses the same tab

  @integration
  Scenario: A run from another machine never navigates my tab
    Given my LangWatch simulations tab is registered with my scenario tab key
    When a run starts on a different machine with a different scenario tab key
    Then LangWatch answers that no tab is listening for that key
    And my open tab is not navigated

  @integration
  Scenario: A manually opened simulations tab is left alone
    Given the user opened the simulations page directly without a scenario tab key
    When a scenario run starts on this machine
    Then that tab does not register as a handoff target
    And the SDK opens its own tab

  # ---------------------------------------------------------------------------
  # Degrading gracefully — old servers, offline, failures
  # ---------------------------------------------------------------------------

  @integration
  Scenario: A LangWatch instance without the endpoint still works
    Given the LangWatch instance returns 404 for the browser-tab handoff endpoint
    When a scenario run starts
    Then the SDK opens the browser as it always did
    And no error is surfaced to the user

  @integration
  Scenario: A slow or unreachable LangWatch never delays a scenario run
    Given the browser-tab handoff endpoint hangs past the SDK's timeout
    When a scenario run starts
    Then the SDK stops waiting within the handoff timeout
    And the scenario run proceeds normally

  @integration
  Scenario: Without the handoff endpoint, repeat runs still stop spamming tabs
    Given the LangWatch instance does not support the browser-tab handoff
    And the SDK opened a tab for this scenario set moments ago
    When another scenario run starts for the same set within the reopen interval
    Then the SDK does not open a second tab
    And the console still prints the follow-it-live URL

  @unit
  Scenario: The reopen interval is per scenario set, not global
    Given the SDK opened a tab for set "checkout-flow" moments ago
    When a run starts for set "onboarding" within the reopen interval
    Then the SDK opens a tab for "onboarding"

  # ---------------------------------------------------------------------------
  # Policy — who decides whether a browser opens at all
  # ---------------------------------------------------------------------------

  @unit
  Scenario Outline: SCENARIO_BROWSER decides the opening policy
    Given SCENARIO_BROWSER is set to "<policy>"
    When a scenario run starts with no tab listening
    Then the SDK <behaviour>

    Examples:
      | policy | behaviour                                                  |
      | auto   | asks for a handoff first and opens only if none happened    |
      | never  | never opens a browser and never asks for a handoff          |
      | always | opens a browser every run, skipping handoff and throttle    |

  @unit
  Scenario: SCENARIO_HEADLESS keeps working as the old opt-out
    Given SCENARIO_HEADLESS is set to "true"
    And SCENARIO_BROWSER is not set
    When a scenario run starts
    Then no browser is opened
    And no browser-tab handoff request is sent

  @unit
  Scenario: An explicit SCENARIO_BROWSER wins over SCENARIO_HEADLESS
    Given SCENARIO_HEADLESS is set to "true"
    And SCENARIO_BROWSER is set to "always"
    When a scenario run starts
    Then a browser is opened

  @unit
  Scenario: CI never opens a browser
    Given the CI environment variable is set
    And SCENARIO_BROWSER is not set
    When a scenario run starts
    Then no browser is opened

  @unit
  Scenario: headless=True in code still suppresses the browser
    Given the scenario config sets headless to true
    When a scenario run starts
    Then no browser is opened

  # ---------------------------------------------------------------------------
  # What the developer sees
  # ---------------------------------------------------------------------------

  @integration
  Scenario: The console explains that a tab was reused
    Given a LangWatch simulations tab is open and registered for this machine
    When a scenario run starts
    Then the console prints that the run was sent to the already-open tab
    And the message appears once per batch, not once per scenario
