Feature: Custom observability configuration
  As a developer running scenarios in a production server process
  I want to control how OpenTelemetry tracing is initialized and what spans are exported
  So that scenario modules don't auto-instrument my entire application

  Background:
    Given a Next.js server with LANGWATCH_API_KEY set in the environment
    And @langwatch/scenario is imported as part of the server process

  @unit
  Scenario: Tracing does not auto-initialize on module import
    When the scenario module is imported
    Then OpenTelemetry is not initialized until a scenario is run or setup is called explicitly
    And no spans are collected from unrelated HTTP requests or middleware

  @integration
  Scenario: Observability initializes lazily on first run
    Given no explicit observability setup has been called
    When a scenario is run via the run() function
    Then observability is initialized with default settings
    And scenario spans are collected and exported to LangWatch

  @integration
  Scenario: User configures observability through scenario.config.js
    Given a scenario.config.js with custom observability options
    When a scenario is run
    Then the observability system uses the user-provided configuration
    And the user's custom span processors receive scenario spans

  @unit
  Scenario: User disables auto-instrumentation to prevent server-wide tracing
    Given observability configured with an empty instrumentations array
    When the scenario module is loaded in a production server
    Then no HTTP, middleware, or framework spans are auto-collected
    And only explicitly created scenario spans are traced

  @integration
  Scenario: User filters spans to only scenario-scoped traces
    Given observability configured with a scenarioOnly filter
    When a scenario runs alongside other server activity
    Then only spans from the @langwatch/scenario instrumentation scope are exported
    And HTTP request spans from the server are excluded

  @integration
  Scenario: User includes custom-tagged spans alongside scenario spans
    Given observability configured with include filters for @langwatch/scenario and a custom scope
    And the user's code creates spans under a custom instrumentation scope
    When a scenario runs that triggers the user's instrumented code
    Then both scenario spans and the user's custom-scoped spans are exported
    And unrelated server spans are still excluded

  @unit
  Scenario: User provides a fully custom setupObservability configuration
    Given a scenario.config.js passing through SetupObservabilityOptions
    When observability initializes
    Then all options are forwarded to the langwatch SDK setupObservability function
    And the judgeSpanCollector processor is always included regardless of user config

  @unit
  Scenario: Explicit setupScenarioTracing call for full control
    Given a user who calls setupScenarioTracing() before any scenario runs
    When a scenario is later run via run()
    Then the explicit setup is used instead of lazy initialization
    And no duplicate OpenTelemetry initialization occurs

  @unit
  Scenario: Backward compatibility when no observability config is provided
    Given no observability configuration in scenario.config.js
    When a scenario is run
    Then observability initializes with the same defaults as before
    And the LANGWATCH_API_KEY environment variable is used for authentication
    And the judgeSpanCollector is registered as a span processor

  @integration
  Scenario: Scenario runs when OTel is already initialized by another SDK
    Given the application has already initialized OpenTelemetry via @vercel/otel or similar
    And the existing provider exports spans to a third-party backend like Datadog
    When a scenario is run
    Then scenario detects the existing provider and skips full OTel re-initialization
    And a LangWatch exporter is added as an additional span processor to the existing provider
    And the judgeSpanCollector is added to the existing provider
    And scenario traces are sent to LangWatch for debugging in the scenario UI
    And the user's existing spans continue flowing to their third-party backend

  @unit
  Scenario: Judge span collector cleans up after each run in long-lived processes
    Given a long-lived server process running scenarios on a schedule
    When a scenario completes
    Then spans for that scenario's thread are cleaned up from the collector
    And memory does not grow unboundedly across multiple scenario runs
