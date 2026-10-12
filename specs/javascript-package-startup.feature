Feature: JavaScript package startup
  Scenario consumers keep the complete SDK API while avoiding work unrelated
  to importing it. The published CommonJS and ES module formats behave alike.

  Scenario: Import without initializing Node telemetry or launching a browser
    When a fresh process imports the published Scenario package
    Then the Node telemetry SDK and browser launcher are not loaded
    And the full LangWatch client entry point is not loaded
    And the ElevenLabs SDK is not loaded
    And text, evaluator and voice factories remain available

  Scenario: Initialize tracing synchronously
    Given a fresh process has imported the published Scenario package
    When it calls setupScenarioTracing with a span processor
    Then a span created immediately after setup is recorded by that processor
    And calling setup again does not register that processor twice
