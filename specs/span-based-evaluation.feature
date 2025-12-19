@python
Feature: Span-based evaluation for judge agent
  As a scenario test author
  I want the judge to evaluate OpenTelemetry spans from my agent
  So that I can verify internal behavior beyond just the conversation

  Background:
    Given an agent instrumented with OpenTelemetry spans
    And a JudgeAgent with span-based criteria

  @e2e
  Scenario: Judge evaluates spans from LangWatch decorators
    Given an agent using @langwatch.span() decorators
    And spans have langwatch.thread.id set to the scenario thread
    When the scenario runs
    Then the judge can see HTTP call spans
    And the judge can see database query spans
    And the judge can see tool execution spans
    And the judge can evaluate criteria based on span content

  @e2e
  Scenario: Judge evaluates spans from native OpenTelemetry API
    Given an agent using native OpenTelemetry context managers
    And spans have langwatch.thread.id set to the scenario thread
    When the scenario runs
    Then the judge can evaluate criteria based on span content

  @unit
  Scenario: Span collector captures spans by thread ID
    Given spans with different thread IDs
    When get_spans_for_thread is called
    Then only spans matching the thread ID are returned
    And child spans inherit thread ID from parents

  @unit
  Scenario: Span digest formatter produces readable output
    Given a list of OpenTelemetry spans
    When formatted into a digest
    Then output includes span names and durations
    And output includes relevant attributes
    And duplicate content is deduplicated
    And media content is truncated

  @unit
  Scenario: Media truncation reduces token usage
    Given span attributes containing base64 data URLs
    When processed by truncate_media
    Then data URLs are replaced with readable markers
    And markers include mime type and approximate size

  @unit
  Scenario: String deduplication reduces token usage
    Given repeated long strings across spans
    When processed by the deduplicator
    Then first occurrence is kept
    And subsequent occurrences are replaced with markers
