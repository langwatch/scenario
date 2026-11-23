@integration
Feature: Granular message events
  As a scenario test author watching a run live in LangWatch
  I want each message reported once, as it starts and as it ends
  So that a long run does not resend the whole conversation on every message

  A run opts in with `sendGranularEvents`, or the SCENARIO_SEND_GRANULAR_EVENTS
  environment variable when the run does not say. Off by default: a run that
  does not opt in reports a full MESSAGE_SNAPSHOT after every message, as before.

  Every messageIndex counts flattened AG-UI rows. A tool message with several
  results is several rows, with ids `<messageId>-<i>`.

  TEXT_MESSAGE_START and TEXT_MESSAGE_END are stored by the platform and keep
  the run's ordered, retried delivery. TEXT_MESSAGE_CONTENT and TOOL_CALL_* are
  only broadcast: they are posted once and never retried.

  The platform keeps the first TEXT_MESSAGE_END per message id and has no
  delete. So a removed message, a message whose index moved, or a stream that
  failed is repaired by one MESSAGE_SNAPSHOT, which replaces the stored list.

  @unit
  Scenario: The environment flag is read strictly
    Given SCENARIO_SEND_GRANULAR_EVENTS is "false"
    Then granular events are off
    And "true", "1", "yes" and "on" turn them on

  @unit
  Scenario: The per-run option wins over the environment flag
    Given SCENARIO_SEND_GRANULAR_EVENTS is "true"
    When the run sets sendGranularEvents to false
    Then the run reports message snapshots

  @integration
  Scenario: A run that does not opt in reports snapshots only
    When a scenario runs without opting in
    Then a MESSAGE_SNAPSHOT is posted after each message
    And no granular message event is posted

  @integration
  Scenario: An opted-in run reports each message once
    When a scenario runs with sendGranularEvents
    Then each message is posted as one TEXT_MESSAGE_START and one TEXT_MESSAGE_END
    And no MESSAGE_SNAPSHOT is posted
    And the bytes posted grow linearly with the number of messages

  @integration
  Scenario: A tool message with several results keeps one row per result
    Given an agent that returns a tool call and a tool message with two results
    When a scenario runs with sendGranularEvents
    Then the tool rows end with ids "<messageId>-0" and "<messageId>-1"
    And their messageIndex values are the rows' positions in the AG-UI list
    And the assistant row's END message carries its tool calls
    And no tool-call progress event is posted for a message that was not streamed

  @integration
  Scenario: Structured audio reaches the platform on the end event
    Given a message whose content holds audio and a transcript
    When it is reported with granular events
    Then the END message keeps the audio as an input_audio part
    And the END content is the transcript text, without the audio bytes

  @integration
  Scenario: A streaming agent reports text as it arrives
    Given an agent that writes an AI SDK text stream to input.stream
    When a scenario runs with sendGranularEvents
    Then a TEXT_MESSAGE_START is posted before the agent call returns
    And the text deltas are posted in batches as TEXT_MESSAGE_CONTENT
    And the TEXT_MESSAGE_END carries the message the call returned, under the started id

  @integration
  Scenario: A streaming agent reports tool-call progress
    Given an agent that streams a tool call, its result and a second step of text
    When a scenario runs with sendGranularEvents
    Then TOOL_CALL_START, TOOL_CALL_ARGS and TOOL_CALL_END are posted for the call
    And the call's parentMessageId is the first step's message id
    And a MESSAGE_SNAPSHOT repairs the second step's index, which the tool rows moved

  @integration
  Scenario: A stream that fails is repaired by a snapshot
    Given an agent that streams text and then throws
    When a scenario runs with sendGranularEvents
    Then the run fails with the agent's error
    And a MESSAGE_SNAPSHOT without the unfinished message is posted before the finished event

  @integration
  Scenario: Nothing is posted for a stream part written after the call settled
    Given an agent that writes to input.stream after its call returned
    Then no event is posted for that part

  @integration
  Scenario: A rollback is repaired by a snapshot
    Given an agent that rolls the conversation back
    When a scenario runs with sendGranularEvents
    Then a MESSAGE_SNAPSHOT of the remaining messages is posted

  @integration
  Scenario: A failed start is retried in order and a failed delta is not
    Given an endpoint that fails the first post of every event
    When a streaming scenario runs with sendGranularEvents
    Then each TEXT_MESSAGE_START and TEXT_MESSAGE_END is delivered, in order
    And each TEXT_MESSAGE_CONTENT is attempted once

  @unit
  Scenario: Snapshots of one run never share a timestamp
    Given two snapshots emitted in the same millisecond
    Then the second carries a later timestamp than the first

  @unit
  Scenario: The vitest reporter rebuilds the chat log without snapshots
    Given an event log of TEXT_MESSAGE_START and TEXT_MESSAGE_END events
    Then the reporter prints each message once, in messageIndex order
