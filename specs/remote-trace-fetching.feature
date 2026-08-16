Feature: Remote trace fetching for judge evaluation
  As a scenario test author testing an agent behind an HTTP endpoint
  I want the scenario to propagate a trace context to my agent and the judge to fetch the resulting traces from LangWatch
  So that criteria about internal behavior (tool calls, writes, retrievals) are judged on real spans, not on the response text

  Background:
    Given a scenario with fetch_remote_traces enabled
    And an agent adapter that forwards the propagation headers to a remote HTTP agent

  @unit
  Scenario: AgentInput carries W3C propagation headers for the current turn
    Given a scenario turn is in progress
    When the agent adapter receives its AgentInput
    Then the input exposes propagation headers containing a traceparent
    And the traceparent trace id equals the trace id stamped on the turn's messages

  @unit
  Scenario: The judge fetches traces for every turn, not only the last
    Given a finished conversation with three turns and three distinct message trace ids
    When the judge issues its verdict
    Then the remote fetcher is asked for all three trace ids

  @unit
  Scenario: Non-verdict judge calls do not wait for trace ingestion
    Given the judge is called mid-conversation and decides to continue
    When remote traces for the latest turn are not yet available
    Then the judge call performs at most one non-blocking fetch round
    And no settle-wait is performed

  @unit
  Scenario: A forced verdict settle-waits until the remote trace is complete
    Given the conversation reached its final turn
    And a remote trace becomes available only after two poll rounds
    When the judge issues its verdict
    Then the fetcher polls until every fetched span's parent resolves within the fetched and locally collected spans
    And the fetched spans are present in the judge's trace digest

  @unit
  Scenario: Chunked ingestion does not settle on a partial trace
    Given remote spans arrive in chunks spaced more than one poll apart
    And the chunk that contains the trace root span arrives last
    When the judge issues its verdict
    Then the fetcher keeps polling past the partial chunks
    And the verdict sees the spans from the last chunk

  @unit
  Scenario: An incomplete trace at the deadline keeps its spans and gains an error span
    Given a remote trace whose spans reference a parent span that never arrives
    When the judge issues its verdict and the wait deadline expires
    Then the collected spans remain available to the judge
    And the trace digest contains a span named langwatch.span_collection.error marking the trace incomplete

  @unit
  Scenario: A trace containing only the scenario's own spans does not settle
    Given the fetched trace contains only spans already collected locally
    When the judge issues its verdict
    Then the fetcher keeps polling until the timeout
    And the trace digest contains a span named langwatch.span_collection.error

  @unit
  Scenario: A voluntary mid-run verdict is re-issued once with complete traces
    Given the judge volunteers a finish_test verdict while remote traces are incomplete
    When the runtime completes the settle-wait fetch
    Then the judge is invoked exactly one more time with the complete trace digest
    And the second verdict is the scenario result

  @unit
  Scenario: Fetch failure produces a synthetic error span and inconclusive criteria guidance
    Given the remote trace fetch times out
    When the judge issues its verdict
    Then the trace digest contains a span named langwatch.span_collection.error with the failure reason
    And the judge system prompt instructs that trace-dependent criteria must not pass on transcript claims alone

  @unit
  Scenario: Remote spans deduplicate against locally collected spans
    Given the scenario's own spans were exported to LangWatch and also collected locally
    When remote traces are merged into the judge span collector
    Then spans already collected locally are not added twice
    And scenario infrastructure spans are filtered out

  @unit
  Scenario: Remote fetching is off by default
    Given a scenario without fetch_remote_traces configured
    When the scenario runs
    Then no remote trace fetch happens
    And the judge sees only locally collected spans

  @integration
  Scenario: Remote spans reach the judge prompt through the standard digest
    Given a fake LangWatch trace API returning a trace with a tool span
    When the scenario runs to a verdict with fetch_remote_traces enabled
    Then the judge LLM request contains the tool span inside the opentelemetry_traces section
