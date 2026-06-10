Feature: Voice scenario survives empty-content user turns in the snapshot emitter
  As a developer running voice scenarios
  I want scenario.run() to complete when the STT/voice pipeline yields an
  empty-content user turn (silence, a dropped segment, or a barge-in)
  So that an otherwise-healthy run is not aborted by the telemetry path that
  serializes the conversation snapshot after every script step

  Background:
    Given a scenario whose conversation state may contain an empty-content user turn

  # AC1 — the run-level contract: no crash, ScenarioResult returned.
  @e2e
  Scenario: A scenario run completes when an empty-content user turn is present
    Given a voice scenario whose STT yields one empty-content user turn during the run
    When scenario.run() executes to completion
    Then it returns a ScenarioResult
    And no "missing required content" ValueError escapes scenario.run()

  # AC2 — converter no longer raises on falsy user content; coerces like assistant.
  @unit
  Scenario Outline: Converter tolerates empty user content instead of raising
    Given a user message whose content is <content>
    When convert_messages_to_api_client_messages serializes the conversation
    Then it does not raise
    And the emitted snapshot contains a user message with empty-string content

    Examples:
      | content      |
      | empty string |
      | None         |
      | empty list   |

  # AC2 — same tolerance must extend to the system role (identical latent crash).
  @unit
  Scenario Outline: Converter tolerates empty system content instead of raising
    Given a system message whose content is <content>
    When convert_messages_to_api_client_messages serializes the conversation
    Then it does not raise
    And the emitted snapshot contains a system message with empty-string content

    Examples:
      | content      |
      | empty string |
      | None         |
      | empty list   |

  # AC2 — coercion is consistent with the role that already worked.
  @unit
  Scenario: Empty user and system content is handled the same way as empty assistant content
    Given an assistant, a user, and a system message that all have empty content
    When convert_messages_to_api_client_messages serializes the conversation
    Then all three roles are coerced to empty-string content without raising
    And the resulting ScenarioMessageSnapshotEvent is a valid event

  # AC2 — non-empty content must keep flowing through unchanged (no regression).
  @unit
  Scenario: Converter preserves non-empty content for every role
    Given user, system, assistant, and tool messages that all have non-empty content
    When convert_messages_to_api_client_messages serializes the conversation
    Then each message's content is serialized unchanged
    And no message is dropped from the snapshot

  # AC3 — the emitter is the safety net: a serialization failure must not abort the run.
  @integration
  Scenario: A failure inside the snapshot emitter degrades to a logged warning
    Given the per-step snapshot emitter raises during conversation serialization
    When scenario.run() reaches the snapshot emission step
    Then the failure is logged as a warning with a traceback
    And the error does not propagate out of scenario.run()
    And the run continues to its verdict

  # AC4(b) — executor-level regression: empty user turn appended, run still completes.
  @integration
  Scenario: An empty-content user turn appended to state does not abort the run
    Given a scenario whose state has an empty-content user turn appended before a script step
    When scenario.run() executes that step and emits the message snapshot
    Then the snapshot is emitted without raising
    And scenario.run() completes and returns a ScenarioResult

  # AC5 — the fix is telemetry-only; real conversation state is untouched.
  @integration
  Scenario: The fix does not mutate the real conversation state
    Given a conversation state containing an empty-content user turn
    When the per-step snapshot is emitted for that state
    Then the snapshot serialization is the only thing that consumes the empty turn
    And _state.messages still contains the empty-content user turn unchanged
    And the agent-visible conversation flow is unchanged

# --- AC Coverage Map ---
# AC1: "no crash on empty user turn — scenario.run() returns a ScenarioResult instead of raising ValueError"
#   → @e2e Scenario: A scenario run completes when an empty-content user turn is present
#   → @integration Scenario: An empty-content user turn appended to state does not abort the run (executor-level)
#
# AC2: "converter tolerates empty user + system content, coerced like assistant; snapshot stays valid"
#   → @unit Scenario Outline: Converter tolerates empty user content instead of raising ("" / None / [])
#   → @unit Scenario Outline: Converter tolerates empty system content instead of raising ("" / None / [])
#   → @unit Scenario: Empty user and system content is handled the same way as empty assistant content
#   → @unit Scenario: Converter preserves non-empty content for every role (no-regression guard)
#
# AC3: "snapshot emission can't abort a healthy run — degrades to a logged warning with traceback"
#   → @integration Scenario: A failure inside the snapshot emitter degrades to a logged warning
#
# AC4: "regression coverage — (a) converter accepts ""/None/[] for user+system; (b) executor run with empty user turn completes"
#   → (a) @unit Converter tolerates empty user/system content (the two Scenario Outlines above)
#   → (b) @integration Scenario: An empty-content user turn appended to state does not abort the run
#
# AC5: "real conversation state untouched — fix is telemetry/serialization only"
#   → @integration Scenario: The fix does not mutate the real conversation state
