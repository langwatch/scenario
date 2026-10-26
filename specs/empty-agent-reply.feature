Feature: A scenario run fails fast when the agent under test returns no content
  As a developer testing an agent with Scenario
  I want the run to stop with a clear error when my agent returns an empty reply
  So that a broken adapter is not hidden behind a user simulator that talks to nobody

  # Issue #1033 — an agent turn with no content (empty string, whitespace, empty list,
  # null content) was added to the conversation as-is. The user simulator and judge then
  # kept running against a silent agent, and the run ended with a misleading verdict.
  #
  # The fix: after the agent-under-test (role AGENT) returns, the executor checks the
  # converted messages. If the turn has no content, it raises
  # "agent returned no content on turn N". The existing adapter-error path then fails
  # the run (both SDKs: the run raises, wrapped as "[AgentName] ..."). The check
  # runs before the messages are added to state.
  #
  # Scope guards (NOT changed):
  #   - User-simulator and judge turns are not checked (existing empty user-turn handling stays).
  #   - Adapters that fail should raise; this check does not replace that (docs note, AC6).
  #
  # SDK symmetry: helper is is_empty_agent_turn (Python) / isEmptyAgentTurn (JS).

  Background:
    Given a scenario with an agent under test, a user simulator and a judge
    And the user simulator and judge are fakes that count their calls (no LLM)

  # ======================================================================
  # AC1 — empty agent turn fails the run at once
  # ======================================================================

  @integration
  Scenario Outline: The run fails when the agent returns <reply> on turn 1
    Given the agent under test returns <reply>
    When the scenario runs
    Then the run raises an error containing "agent returned no content on turn 1"
    And the user simulator was called once
    And the judge was never called

    Examples:
      | reply                        |
      | an empty string              |
      | a whitespace-only string     |
      | an empty list                |
      | a message with null content  |

  @integration
  Scenario: The turn number in the error is the current turn
    Given the agent under test replies "hello" on turn 1 and returns an empty string on turn 2
    When the scenario runs
    Then the run raises an error containing "agent returned no content on turn 2"

  # ======================================================================
  # AC2 — what counts as "no content" (helper)
  # ======================================================================

  @unit
  Scenario Outline: The helper treats <case> as an empty agent turn
    When the helper checks <case>
    Then it returns true

    Examples:
      | case                                              |
      | no messages                                       |
      | one message with content ""                       |
      | one message with whitespace-only content          |
      | one message with null content                     |
      | one message with an empty content list            |
      | one message whose only text parts are blank       |
      | several messages that are all empty               |

  @unit
  Scenario Outline: The helper treats <case> as content
    When the helper checks <case>
    Then it returns false

    Examples:
      | case                                                          |
      | one message with text content                                 |
      | an assistant message with tool calls and empty content        |
      | a tool message (PY role "tool" / JS tool-result parts)        |
      | a message with an audio, image or file part                   |
      | one empty message next to one message with text               |

  # ======================================================================
  # AC3 — short replies are content
  # ======================================================================

  @integration
  Scenario: A "-" reply is content and the run goes on
    Given the agent under test returns "-"
    When the scenario runs
    Then the run does not raise
    And the judge is called

  # ======================================================================
  # AC4 — tool-only and voice turns unchanged
  # ======================================================================

  @integration
  Scenario: A tool-only agent turn is not flagged
    Given the agent under test returns an assistant message with tool calls and no text
    When the scenario runs
    Then the run does not raise

  # ======================================================================
  # AC5 — user simulator and judge are not checked
  # ======================================================================

  @integration
  Scenario: An empty user-simulator turn is not flagged by this check
    Given the user simulator returns an empty string
    And the agent under test returns "hello"
    When the scenario runs
    Then the error "agent returned no content" is never raised

  # ======================================================================
  # AC4 (cont.) — other turns not checked; AC1 — empty turn not stored
  # ======================================================================

  @integration
  Scenario: A ScenarioResult return from the agent is not flagged
    Given the agent under test returns a ScenarioResult
    When the scenario runs
    Then the error "agent returned no content" is never raised

  @integration
  Scenario: A scripted agent step with blank text is not flagged
    Given the script supplies an agent message with blank content
    When the scenario runs
    Then the error "agent returned no content" is never raised

  # Voice agent adapters are not checked; no automated test (needs the realtime harness).

  @integration
  Scenario: A rejected empty turn is not added to the conversation
    Given the agent under test returns an empty string
    When the scenario runs and raises
    Then state.messages holds no assistant message

  # ======================================================================
  # AC6 / AC7 — docs and proof (not test-automated here)
  # ======================================================================
  # AC6: adapter docs say adapters raise on error, not return a placeholder reply (docs review).
  # AC7: a real scenario run with an empty-reply agent fails at turn 1; output pasted in the PR.

  # --- AC Coverage Map ---
  # AC 1: "empty agent turn fails the run with 'agent returned no content on turn N'; no more sim/judge calls" ->
  #   Scenario Outline: The run fails when the agent returns <reply> on turn 1 (@integration)
  #   Scenario: The turn number in the error is the current turn (@integration)
  # AC 2: "definition of no content" ->
  #   Scenario Outline: The helper treats <case> as an empty agent turn (@unit)
  #   Scenario Outline: The helper treats <case> as content (@unit)
  # AC 3: "'-' is content" ->
  #   Scenario: A "-" reply is content and the run goes on (@integration)
  # AC 4: "tool-only and audio turns unchanged" ->
  #   Scenario: A tool-only agent turn is not flagged (@integration)
  #   Scenario Outline: The helper treats <case> as content (@unit)
  # AC 1 (cont.): Scenario: A rejected empty turn is not added to the conversation (@integration)
  # AC 4 (cont.): ScenarioResult and scripted-agent scenarios (@integration); voice not tested
  # AC 5: "user-sim and judge turns not checked" ->
  #   Scenario: An empty user-simulator turn is not flagged by this check (@integration)
  # AC 6: "docs say adapters raise on error" -> docs review, no automated test
  # AC 7: "real run proof in the PR" -> manual proof, no automated test
