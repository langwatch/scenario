Feature: Claude Code adapter environment, transcript and process lifecycle
  As a skill test author
  I want the Claude Code adapter to shape the CLI environment, report the turn as structured messages and leave no process behind
  So that a skill suite can drop its own adapter and a killed test run stops costing tokens

  Background:
    Given a Claude Code adapter driven against a fake CLI process

  @unit
  Scenario: The CLI environment is this process's with the configured keys on top
    Given the harness environment holds an API key and a batch run id
    And the adapter is configured with env setting a new key and removing the batch run id
    When a turn runs
    Then the CLI receives the new key
    And the CLI does not receive the batch run id
    And the CLI still receives the API key
    And the CLI receives FORCE_COLOR set to 0

  @unit
  Scenario: A turn is returned as AI SDK messages when output is messages
    Given the adapter is configured with output messages
    And the CLI transcript holds an assistant text, a tool call and its result
    When a turn runs
    Then the turn is an assistant message with a text part and a tool-call part
    And a tool message with a tool-result part naming the tool

  @unit
  Scenario: A turn is returned as text by default
    Given the CLI transcript holds an assistant text, a tool call and its result
    When a turn runs
    Then the turn is the text with the tool call and its result rendered inline

  @unit
  Scenario: A transcript becomes AI SDK messages with tool-call and tool-result parts
    Given a transcript holding thinking, text, tool_use and tool_result blocks
    When the transcript is converted
    Then each assistant turn is a text part followed by a tool-call part per tool_use block
    And each tool_result block is a tool-result part of a tool message naming the tool it answers
    And the thinking is not in the messages

  @unit
  Scenario: An assistant turn that only calls tools keeps an empty text part
    Given a transcript whose assistant turn holds only a tool_use block
    When the transcript is converted
    Then the assistant message holds an empty text part followed by the tool-call part

  @unit
  Scenario: A block the conversation cannot carry leaves a line naming it
    Given a transcript holding an image block on an assistant turn and a document block on a user turn
    When the transcript is converted
    Then the assistant text ends with a line naming the image block
    And the user message is a line naming the document block

  @unit
  Scenario: A failed tool result is an error-text output
    Given a transcript whose tool_result block is marked as an error
    When the transcript is converted
    Then the tool-result part carries an error-text output

  @unit
  Scenario: Tool inputs and results are capped in both renderings
    Given a transcript whose tool call input and tool result each carry far more text than a judge can read
    When the transcript is converted
    Then the tool call input is capped and says how many characters were dropped
    And a string nested inside the input is capped the same way
    And the tool result is capped the same way
    And the text rendering of the same transcript is capped the same way
    And a small tool call is left alone

  @unit
  Scenario: The caps are configurable on the adapter
    Given the adapter is configured with output messages and a tool result cap of 100 characters
    And the CLI transcript holds a tool result of 500 characters
    When a turn runs
    Then the tool-result part holds 100 characters plus the dropped count

  @unit
  Scenario: The Bash commands of a run are read from the tool-call parts
    Given a conversation with a Bash tool call, a Read tool call and text quoting a command
    When the Bash commands are read
    Then only the command of the Bash tool call is listed

  @unit
  Scenario: An existing CLAUDE.md is pointed at the installed skills
    Given a working directory with two installed skills and a CLAUDE.md that mentions one of them
    When the CLAUDE.md is pointed at the skills
    Then the CLAUDE.md keeps its content
    And it gains an instruction to read the skill it did not mention
    And pointing it again changes nothing

  @unit
  Scenario: A working directory without skills is left alone
    Given a working directory with no .skills folder
    When the CLAUDE.md is pointed at the skills
    Then no CLAUDE.md is written

  @unit
  Scenario: The CLI is spawned as the leader of its own process group
    When a turn runs
    Then the CLI is spawned detached

  @unit
  Scenario: A timeout kills the whole process group
    Given the adapter is configured with a short timeout
    And the CLI never closes
    When the timeout elapses
    Then SIGTERM is sent to the CLI's process group
    And SIGKILL follows to the same group shortly after
    And the turn rejects with a timeout error

  @unit
  Scenario: A watchdog outlives the harness and is told both pids
    When a turn runs
    Then a detached shell watchdog is spawned with the harness pid and the CLI pid
    And the watchdog is unreferenced so it keeps the harness alive no longer than the CLI
    And the watchdog is not spawned again for a CLI that has no pid

  @unit
  Scenario: A watchdog that cannot start does not fail the turn
    Given the watchdog process reports a spawn error
    When a turn runs
    Then the turn resolves with the CLI's output

  @unit
  Scenario: A CLI still running when the harness exits gets SIGKILL
    Given a turn is running
    When the harness process emits exit
    Then SIGKILL is sent to the CLI's process group

  @unit
  Scenario: A turn that finished is not killed on harness exit
    Given a turn ran to completion
    When the harness process emits exit
    Then nothing is sent to that CLI's process group
