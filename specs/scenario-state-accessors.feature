Feature: Scenario state accessors
  As a scenario test author
  I want the scenario state to expose the conversation, the scenario definition and the trace
  So that a script step and an evaluator mapping read the run through one object

  Background:
    Given a scenario run with fields, judge criteria, messages and collected spans

  @unit
  Scenario: The state exposes the scenario fields
    Given the scenario declares the field golden_sql
    When a script step reads the fields
    Then fields holds golden_sql and its value
    And field golden_sql returns the value
    And field of a name the scenario does not set returns nothing
    And a field set to zero or false returns that value

  @unit
  Scenario: The state exposes the judge criteria
    Given a judge with two criteria
    When a script step reads the criteria
    Then criteria lists both, in order

  @unit
  Scenario: The state renders the conversation
    Given a user message, an assistant tool call and an assistant answer
    When a script step reads the first user message, the last agent message and the transcript
    Then the first user message is the text of the first user message
    And the last agent message is the text of the last assistant message
    And the transcript is one role and content line per message

  @unit
  Scenario: Tool calls merge the messages and the spans in start order
    Given the agent returned a run_sql tool call in its messages
    And the trace holds a run_sql tool span for a second call
    When a script step reads the run_sql tool calls
    Then two calls are listed, the message call first
    And each call carries its name, input, output, turn and source

  @unit
  Scenario: A span that describes a message tool call is not listed twice
    Given the agent returned a run_sql tool call with an input in its messages
    And the trace holds a run_sql tool span with the same input
    When a script step reads the run_sql tool calls
    Then one call is listed

  @unit
  Scenario: A tool call collection picks with first and last
    Given three run_sql calls
    When a script step reads the collection
    Then first is the first call and last is the third
    And inputs lists the three inputs in order
    And the collection iterates, indexes and counts the three calls

  @unit
  Scenario: An empty tool call collection has no pick
    Given no run_sql call
    When a script step reads the collection
    Then first and last are nothing
    And inputs and outputs are empty
    And the collection counts zero calls

  @unit
  Scenario: The state exposes the spans of the run so far
    Given the collector holds spans of this thread and of another thread
    When a script step reads the spans
    Then only the spans of this thread are listed, in start order
    And reading the spans never fetches remote traces

  @unit
  Scenario: The state exposes the retrieved contexts
    Given the trace holds a rag span with two documents
    When a script step reads the contexts
    Then both document contents are listed

  @unit
  Scenario: The state groups spans by trace
    Given messages of two turns with two trace ids
    And spans of both traces
    When a script step reads the traces
    Then two traces are listed in the order the messages saw them
    And each trace holds its id and its spans
    And each trace lists its own tool calls

  @unit
  Scenario: The state groups messages by turn
    Given messages added over two turns
    When a script step reads the turns
    Then two turns are listed with their index
    And each turn holds the messages added in it
    And each turn holds the trace of its messages
    And each turn lists its own tool calls
