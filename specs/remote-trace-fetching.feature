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
  Scenario: Conversation turns never fetch remote traces
    Given the judge is called mid-conversation and decides to continue
    When the decision call completes
    Then no remote trace fetch happens at all

  @unit
  Scenario: A forced verdict settle-waits until the remote trace is complete
    Given the conversation reached its final turn
    And a remote trace becomes available only after two poll rounds
    When the judge issues its verdict
    Then the fetcher polls until every fetched agent span's parent resolves within the fetched and locally collected spans
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
  Scenario: The scenario's own spans echoed back do not block settling
    Given the platform echoes back one of the scenario's own spans whose parent span is still open
    And the agent's spans are fully ingested
    When the judge issues its verdict
    Then the trace settles on the first poll

  @unit
  Scenario: A make_verdict decision settles the traces before the verdict
    Given the judge decides mid-conversation that enough information has been collected
    When the verdict call runs
    Then the settle-wait completes before the verdict prompt is built
    And the fetched spans are present in the verdict's trace digest

  @unit
  Scenario: Fetch failure produces a synthetic error span and inconclusive criteria guidance
    Given the remote trace fetch times out
    When the judge issues its verdict
    Then the trace digest contains a span named langwatch.span_collection.error with the failure reason
    And the judge system prompt instructs that trace-dependent criteria must not pass on transcript claims alone

  @unit
  Scenario: A fractional wait budget does not break the fetch
    Given the settle-wait budget is a fractional number of milliseconds
    When the judge settle-waits for the remote trace
    Then the trace settles normally without a synthetic error span

  @unit
  Scenario: A poll in flight at the deadline still yields the timeout reason
    Given a remote trace that never arrives within the budget
    When the settle-wait deadline expires while a poll is in flight
    Then the synthetic error span reports that no agent spans arrived rather than an aborted fetch

  @unit
  Scenario: A failed poll retries until the deadline instead of failing the trace
    Given the first trace fetch fails and a later fetch returns the complete trace
    When the judge settle-waits for the remote trace
    Then the trace settles normally without a synthetic error span

  @unit
  Scenario: A voluntary inconclusive verdict is terminal when no remote trace ever settled
    Given remote trace fetching is enabled and every trace terminally failed to settle
    When the judge volunteers a verdict and it comes back inconclusive
    Then the verdict is final and the conversation does not continue

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
