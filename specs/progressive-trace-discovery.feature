Feature: Progressive trace discovery for large OTEL traces
  As a scenario test author
  I want the judge to handle arbitrarily large OpenTelemetry traces
  So that scenarios with massive RAG pipelines or long-running agents don't blow up the judge's context window

  Background:
    Given an agent instrumented with OpenTelemetry
    And a JudgeAgent with success criteria

  # --- Token Estimation & Mode Selection ---

  @unit
  Scenario: Small traces are rendered inline as before
    Given a trace with 10 spans totaling under 8192 estimated tokens
    When the judge formats the trace
    Then the full trace digest is rendered inline with all attributes and events
    And no expand or grep tools are provided to the judge

  @unit
  Scenario: Large traces trigger structure-only mode
    Given a trace with 200 spans totaling over 8192 estimated tokens
    When the judge formats the trace
    Then only the span tree structure is rendered (names, durations, error indicators)
    And span attributes, events, and content are omitted
    And the judge receives expand_trace and grep_trace tools

  @unit
  Scenario: Token estimation uses character-based heuristic
    Given a rendered trace digest string
    When estimating its token count
    Then the estimate uses a ~4 characters per token ratio
    And the threshold for switching modes is configurable (default 8192 tokens)

  # --- Structure-Only Rendering ---

  @unit
  Scenario: Structure-only digest preserves span hierarchy
    Given a trace with nested parent-child spans
    When rendered in structure-only mode
    Then the tree structure with indentation is preserved
    And each span shows: index, timestamp, name, duration, and error status
    And attributes and events are not shown
    And a note tells the judge to use expand_trace or grep_trace for details

  @unit
  Scenario: Structure-only digest includes summary stats
    Given a trace with 150 spans and 3 errors
    When rendered in structure-only mode
    Then the header shows total span count and duration
    And the errors section still lists all error spans

  # --- Expand Tool ---

  @unit
  Scenario: Expand tool returns full details for a single span
    Given a trace with span [42] having attributes, events, and content
    When the judge calls expand_trace with span index 42
    Then the response includes the full span details with all attributes and events
    And the response shows the span's position in the tree hierarchy

  @unit
  Scenario: Expand tool returns details for a range of spans
    Given a trace with spans [10] through [15]
    When the judge calls expand_trace with span range "10-15"
    Then the response includes full details for spans 10 through 15
    And the tree structure context is preserved

  @integration
  Scenario: Expand tool handles invalid span index
    Given a trace with 50 spans
    When the judge calls expand_trace with span index 99
    Then the response indicates the span index is out of range
    And suggests the valid range (1-50)

  # --- Grep Tool ---

  @unit
  Scenario: Grep tool searches across all span attributes and events
    Given a trace where span [23] contains "fetch_report" in its tool name
    And span [45] contains "fetch_report" in its content
    When the judge calls grep_trace with pattern "fetch_report"
    Then results show both spans with their tree position as header
    And matching content is shown with context

  @integration
  Scenario: Grep results are limited to prevent context overflow
    Given a trace where 100 spans match the search pattern
    When the judge calls grep_trace with pattern "error"
    Then only the first 20 matches are returned
    And a note indicates there are more results
    And suggests the judge refine the search pattern

  @integration
  Scenario: Grep with no results returns helpful message
    Given a trace with 50 spans
    When the judge calls grep_trace with pattern "nonexistent_xyz"
    Then the response indicates no matches found
    And suggests alternative search terms based on available span names

  @unit
  Scenario: Grep is case-insensitive by default
    Given a trace with span content containing "DatabaseInsert"
    When the judge calls grep_trace with pattern "databaseinsert"
    Then the span is found and returned

  # --- Agentic Judge Loop ---

  @integration
  Scenario: Judge uses tools to investigate large traces
    Given a trace with 200 spans exceeding the token threshold
    And criteria checking whether a specific tool was called successfully
    When the judge evaluates the scenario
    Then the judge first receives the structure-only digest
    And the judge uses grep_trace or expand_trace to find relevant spans
    And the judge makes a verdict based on the discovered details

  @integration
  Scenario: Judge loop has a maximum iteration limit
    Given a trace in structure-only mode
    When the judge keeps calling tools without reaching a verdict
    Then the loop stops after a configurable maximum steps (default 10)
    And the judge is forced to make a verdict with available information

  @integration
  Scenario: Judge continues scenario after gathering trace information
    Given a trace in structure-only mode
    When the judge has used expand and grep to gather information
    And determines the scenario should continue
    Then the judge calls continue_test to let the scenario proceed

  @integration
  Scenario: Judge finishes scenario with verdict after gathering trace information
    Given a trace in structure-only mode
    When the judge has used expand and grep to gather information
    And determines enough evidence exists for a verdict
    Then the judge calls finish_test with a verdict and reasoning

  # --- Cumulative Context Budget ---

  @integration
  Scenario: Expand results are truncated to fit within budget
    Given a trace in structure-only mode
    And the judge calls expand_trace on a span with massive content
    When the expand result exceeds 4096 estimated tokens
    Then the result is truncated with a note about the truncation
    And suggests using grep_trace to find specific content within the span

  @integration
  Scenario: Grep results respect per-result token budget
    Given a trace where matching spans have very long content
    When the judge calls grep_trace
    Then each match result is capped to show only the matching line with context
    And total grep output is limited to 4096 estimated tokens

  # --- Reusable Utilities for Custom Judges ---

  @unit
  Scenario: Standalone expand_trace returns full span details
    Given a span array with 50 spans
    When calling the standalone expandTrace function with span index 5
    Then it returns the same formatted output as the built-in judge tool
    And it works without instantiating a JudgeAgent

  @unit
  Scenario: Standalone grep_trace searches span content
    Given a span array with 50 spans containing "database_query"
    When calling the standalone grepTrace function with pattern "database"
    Then it returns matching spans with tree context
    And it works without instantiating a JudgeAgent

  @unit
  Scenario: Standalone estimateTokens calculates token count
    Given a string of 4000 characters
    When calling the standalone estimateTokens function
    Then it returns approximately 1000 tokens

  # --- Backward Compatibility ---

  @integration
  Scenario: Existing judge behavior unchanged for small traces
    Given a scenario with a simple agent producing 5 spans
    When the scenario runs with the default judge
    Then the judge behavior is identical to before this feature
    And no tools are added to the LLM call
    And the trace is rendered inline in full

  @integration
  Scenario: Custom system prompt works with progressive discovery
    Given a judge with a custom system prompt
    And a trace exceeding the token threshold
    When the scenario runs
    Then the custom system prompt is preserved
    And the expand/grep tools are still available

  # --- Edge Cases ---

  @integration
  Scenario: Empty trace renders the same regardless of mode
    Given a trace with 0 spans
    When the judge formats the trace
    Then it returns "No spans recorded." regardless of mode

  @integration
  Scenario: Trace just at the token threshold boundary renders inline
    Given a trace that renders to exactly 8192 estimated tokens
    When the judge formats the trace
    Then it renders inline (threshold is exclusive - must exceed to trigger structure-only)
