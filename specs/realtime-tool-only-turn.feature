Feature: OpenAI Realtime adapter handles tool-only turns without audio
  As a developer writing a voice scenario test against a tool-calling realtime agent
  I want call() to return the accumulated tool call when the model responds with a function
  call but no spoken audio
  So that my scenario can assert on tool-call state even when the agent acts silently

  # Issue #646 — call() (both SDKs) was gated on an audio chunk it may never receive.
  # A tool-only turn (function call, no response.output_audio.delta) caused call() to
  # hang until the response_timeout deadline and raise, discarding the fully-parsed tool
  # call. The fix: treat response.done + a non-empty tool-call accumulator as a valid
  # terminal path, returning the accumulated message without requiring audio.
  #
  # Scope guards (NOT changed, per Investigation):
  #   - Cross-SDK message shape convergence (PY tool_calls array vs JS tool-result parts)
  #     is out of scope — each SDK keeps its own existing consumer shape (#640).
  #   - Live-API / real-OpenAI-key E2E smoke is deferred (hermetic mock-WS tests are
  #     the contract for this issue).
  #   - Type-annotation cleanup nits tracked separately (#644).
  #
  # SDK symmetry: AC1/AC2/AC3/AC4/AC5 name both SDKs explicitly. Where the behaviour
  # differs by SDK (message shape), paired scenarios or outline examples make both
  # visible. AC6-AC11 cover consequences + regressions, each with both-SDK evidence.

  Background:
    Given an OpenAIRealtimeAgentAdapter under test with a mock WebSocket (no live API key)
    And the adapter's response_timeout is set to a short value so tests complete quickly

  # ======================================================================
  # AC1 — PY: tool-only turn returns the tool-call assistant message, no timeout
  # ======================================================================

  @unit
  Scenario: PY call() returns an assistant tool-call message on a tool-only turn
    # AC1: streaming-args event form — response.created → function_call_arguments.delta×N
    # → .done → response.done, no audio delta. call() must return and not raise.
    Given the mock WebSocket will emit:
      response.created, response.function_call_arguments.delta (×2), response.function_call_arguments.done, response.done
      and NO response.output_audio.delta event
    When PY call() is invoked
    Then it returns a message with role "assistant"
    And the message contains a non-empty tool_calls list
    And each tool_calls entry has id, type "function", and function.name and function.arguments
    And call() does not raise asyncio.TimeoutError

  @unit
  Scenario: PY call() accepts the output-item event form for a tool-only turn
    # AC4 (PY half): response.output_item.done carrying a function_call item as the
    # sole terminal source — no streaming-delta form needed.
    Given the mock WebSocket will emit:
      response.created, response.output_item.done (carrying a function_call item), response.done
      and NO response.output_audio.delta event
    When PY call() is invoked
    Then it returns a message with role "assistant" and a non-empty tool_calls list
    And call() does not raise asyncio.TimeoutError

  # ======================================================================
  # AC2 — JS: tool-only turn returns the tool-result message, no timeout
  # ======================================================================

  @unit
  Scenario: JS call() returns a tool-result message on a tool-only turn
    # AC2: streaming-args event form — response.created → function_call_arguments.delta×N
    # → .done → response.done, no audio delta. JS call() must return and not raise.
    # NOTE: JS surfaced shape is role:"tool" + tool-result content parts, NOT the PY
    # tool_calls array — each SDK asserts its own consumer shape (#640 out of scope).
    Given the mock WebSocket will emit:
      response.created, response.function_call_arguments.delta (×2), response.function_call_arguments.done, response.done
      and NO audio delta event
    When JS call() is invoked
    Then it returns a message with role "tool"
    And the message content contains at least one part with type "tool-result"
    And each tool-result part carries toolCallId, toolName, and output
    And call() does not throw the receiveAudio timeout error

  @unit
  Scenario: JS call() accepts the output-item event form for a tool-only turn
    # AC4 (JS half): output-item event form as the sole terminal source.
    Given the mock WebSocket will emit:
      response.created, response.output_item.done (carrying a function_call item), response.done
      and NO audio delta event
    When JS call() is invoked
    Then it returns a message with role "tool" and at least one tool-result part
    And call() does not throw the receiveAudio timeout error

  # ======================================================================
  # AC3 — End-to-end consumability through converter into ScenarioState
  # ======================================================================

  @integration
  Scenario: PY tool-only message is consumable via state.has_tool_call after conversion
    # AC3 (PY): the returned message must survive convert_agent_return_types_to_openai_messages
    # into ScenarioState so the public assertion API works — not merely returned raw.
    Given call() returns a tool-only assistant message for a function named "get_weather"
      with arguments '{"location": "Paris"}'
    When the message is passed through the PY converter into ScenarioState
    Then state.has_tool_call("get_weather") is True
    And state.last_tool_call("get_weather")["function"]["arguments"] equals '{"location": "Paris"}'

  @integration
  Scenario: JS tool-only message is consumable via state.hasToolCall after conversion
    # AC3 (JS): the returned message must survive convertAgentReturnTypesToMessages
    # into ScenarioState. JS shape is role:"tool"/tool-result, not tool_calls array.
    Given JS call() returns a tool-only role:"tool" message for a function named "get_weather"
      with output containing '{"location": "Paris"}'
    When the message is passed through the JS converter into ScenarioState
    Then state.hasToolCall("get_weather") is True
    And state.lastToolCall("get_weather") returns a message with a matching tool-result part

  # ======================================================================
  # AC4 — Both event forms accepted (streaming-args AND output-item)
  # Covered above in AC1/AC2 scenario pairs; this scenario covers parametric proof.
  # ======================================================================

  @unit
  Scenario Outline: Both SDKs accept both tool-call event forms on a tool-only turn
    # AC4: parametrized over SDK × event-form. All four combinations must pass.
    Given a <sdk> adapter with a mock WebSocket
    And the mock WebSocket emits a tool-only turn via the <event_form> event form
      with no audio delta
    When call() is invoked
    Then it returns a tool call message in the <sdk> consumer shape
    And call() does not raise or throw a timeout error

    Examples:
      | sdk | event_form                    |
      | PY  | streaming-args (delta×N+done) |
      | PY  | output-item.done              |
      | JS  | streaming-args (delta×N+done) |
      | JS  | output-item.done              |

  # ======================================================================
  # AC5 — Multiple simultaneous function calls on a tool-only turn
  # ======================================================================

  @unit
  Scenario: PY call() surfaces both function calls when a tool-only turn emits two
    # AC5 (PY): two distinct function calls before response.done — both must appear
    # in the returned message; neither is dropped.
    Given the mock WebSocket will emit a tool-only turn with two function calls:
      "get_weather" with args '{"location": "Paris"}' and "get_time" with args '{"tz": "UTC"}'
      and NO audio delta
    When PY call() is invoked
    Then the returned message has role "assistant"
    And tool_calls contains exactly 2 entries
    And one entry has function.name "get_weather"
    And one entry has function.name "get_time"

  @unit
  Scenario: JS call() surfaces both function calls when a tool-only turn emits two
    # AC5 (JS): same multi-call invariant for the JS consumer shape.
    Given the mock WebSocket will emit a tool-only turn with two function calls:
      "get_weather" and "get_time" and NO audio delta
    When JS call() is invoked
    Then the returned message has role "tool"
    And the content contains exactly 2 tool-result parts
    And one part has toolName "get_weather"
    And one part has toolName "get_time"

  # ======================================================================
  # AC6 — Regression: tool-free spoken turn still returns a single audio message
  # ======================================================================

  @integration
  Scenario: A tool-free spoken turn still returns a single audio message unchanged
    # AC6: the existing audio-only path must be unperturbed by the new terminal.
    # PY: a dict (not a list) with role "assistant", no "tool_calls" key.
    # JS: a single role:"assistant" audio message, no trailing role:"tool" message.
    Given the mock WebSocket emits a normal spoken turn with audio deltas and NO function call
    When call() is invoked in both SDKs
    Then PY returns a single dict with role "assistant" and no "tool_calls" key
    And JS returns a single role "assistant" audio message with no tool-result content
    And neither SDK raises an error

  # ======================================================================
  # AC7 — Regression: audio+tool turn still returns both messages (#635 case)
  # ======================================================================

  @integration
  Scenario: An audio-plus-tool turn still surfaces both the audio message and the tool-call message
    # AC7: the #635 coexistence case — model speaks AND calls a tool in the same turn.
    # Both messages must be present after the fix.
    Given the mock WebSocket emits a turn with both audio deltas and a function call
    When call() is invoked in both SDKs
    Then PY returns a list with an audio assistant message followed by a tool_calls assistant message
    And JS returns a list with an audio assistant message followed by a role:"tool" message
    And neither SDK raises an error

  # ======================================================================
  # AC8 — Cross-turn no-bleed: turn 1 tool-only, turn 2 audio-only
  # ======================================================================

  @unit
  Scenario: Turn-2 audio message carries no tool calls when turn-1 was tool-only
    # AC8: two sequential call() invocations on the same adapter instance.
    # Turn 1 is tool-only (no audio); turn 2 is audio-only (no function call).
    # Turn 2 must return a clean audio message with no bleed-over from turn 1.
    Given a single adapter instance is used for two sequential turns
    And turn 1 emits a tool-only event sequence (function call, no audio)
    And turn 2 emits an audio-only event sequence (audio deltas, no function call)
    When call() is invoked twice in sequence on the same adapter
    Then the turn-2 return value has role "assistant" in PY (a dict, not a list)
    And the turn-2 return value has no "tool_calls" key in PY
    And the turn-2 return value has no role:"tool" trailing message in JS
    And the turn-1 tool call does not appear in the turn-2 result

  # ======================================================================
  # AC9 — Failure mode: genuinely empty turn still raises the timeout error
  # ======================================================================

  @unit
  Scenario: A genuinely empty turn raises the timeout error and does not return
    # AC9: response.created → response.done with NO audio delta AND an empty tool-call
    # accumulator. The new terminal path keys on done+non-empty-accumulator; an empty
    # accumulator must still surface the real hang rather than returning silently.
    Given the mock WebSocket emits response.created then response.done
      with NO audio delta and NO function call events
    When PY call() is invoked
    Then asyncio.TimeoutError is raised
    And the error message is "OpenAIRealtimeAgentAdapter: recv_audio timed out"
    And call() does not return a value

  @unit
  Scenario: A genuinely empty turn raises the timeout error in JS and does not return
    # AC9 (JS half): same contract for the JS adapter.
    Given the mock WebSocket emits response.created then response.done
      with NO audio delta and NO function call events
    When JS call() is invoked
    Then it throws an Error
    And the error message is "OpenAIRealtimeAgentAdapter: receiveAudio timed out"
    And call() does not return a value

  # ======================================================================
  # AC10 — Failure mode: malformed arguments degrade gracefully (no-audio path)
  # ======================================================================

  @unit
  Scenario: A tool-only turn with malformed function arguments returns without raising
    # AC10: the no-audio path combined with bad/missing args — mirrors the existing
    # #635 malformed-args contract (test_ac7a/test_ac7b) but on the no-audio path.
    # PY: arguments degraded to raw string or "{}". JS: output is parsed JSON or raw string.
    Given the mock WebSocket emits a tool-only turn where the function_call arguments
      are malformed or missing
    When PY call() is invoked
    Then it returns a message with role "assistant" and a tool_calls entry
    And the function.arguments field is the raw argument string or "{}" without raising

  @unit
  Scenario: A tool-only JS turn with malformed function arguments returns without raising
    # AC10 (JS half): same degraded-args contract on the no-audio JS path.
    Given the mock WebSocket emits a tool-only turn where the function_call arguments
      are malformed or missing
    When JS call() is invoked
    Then it returns a role:"tool" message with a tool-result part
    And the output field contains the parsed JSON value or the raw string verbatim without throwing

  # ======================================================================
  # AC11 — Full keyless suites stay green after the change
  # ======================================================================

  @unit
  Scenario: The full PY keyless realtime tool-call suite passes after the fix
    # AC11 (PY): uv run pytest tests/voice/test_realtime_tool_calls.py must pass.
    # All pre-existing scenarios (audio+tool coexistence, tool-free turn, etc.) plus
    # the new no-audio cases must all be green together.
    Given the PY keyless suite tests/voice/test_realtime_tool_calls.py
    When the suite is run with no live API key
    Then all tests pass
    And the pass count includes both the pre-existing #635 regression tests and the new AC1-AC10 cases

  @unit
  Scenario: The full JS keyless realtime tool-call suite passes after the fix
    # AC11 (JS): pnpm vitest run src/voice/adapters/__tests__/openai-realtime-tool-calls.test.ts
    # (from javascript/) must pass. All pre-existing and new no-audio cases green together.
    Given the JS keyless suite javascript/src/voice/adapters/__tests__/openai-realtime-tool-calls.test.ts
    When the suite is run with no live API key
    Then all tests pass
    And the pass count includes both the pre-existing #635 regression tests and the new AC1-AC10 cases

  # --- AC Coverage Map ---
  # AC 1: "PY call() returns tool-call assistant message on tool-only turn, no timeout" ->
  #   Scenario: PY call() returns an assistant tool-call message on a tool-only turn (@unit)
  # AC 2: "JS call() returns tool-result message on tool-only turn, no timeout" ->
  #   Scenario: JS call() returns a tool-result message on a tool-only turn (@unit)
  # AC 3: "Surfaced tool call consumable end-to-end via has_tool_call/hasToolCall" ->
  #   Scenario: PY tool-only message is consumable via state.has_tool_call after conversion (@integration)
  #   Scenario: JS tool-only message is consumable via state.hasToolCall after conversion (@integration)
  # AC 4: "Both streaming-args and output-item event forms accepted as sole terminal source" ->
  #   Scenario: PY call() accepts the output-item event form for a tool-only turn (@unit)
  #   Scenario: JS call() accepts the output-item event form for a tool-only turn (@unit)
  #   Scenario Outline: Both SDKs accept both tool-call event forms on a tool-only turn (@unit)
  # AC 5: "Two simultaneous function calls both surfaced on a tool-only turn" ->
  #   Scenario: PY call() surfaces both function calls when a tool-only turn emits two (@unit)
  #   Scenario: JS call() surfaces both function calls when a tool-only turn emits two (@unit)
  # AC 6: "Regression — tool-free spoken turn still returns a single audio message" ->
  #   Scenario: A tool-free spoken turn still returns a single audio message unchanged (@integration)
  # AC 7: "Regression — audio+tool turn (#635 case) still surfaces both messages" ->
  #   Scenario: An audio-plus-tool turn still surfaces both the audio message and the tool-call message (@integration)
  # AC 8: "Cross-turn no-bleed — turn-1 tool state does not appear in turn-2 audio result" ->
  #   Scenario: Turn-2 audio message carries no tool calls when turn-1 was tool-only (@unit)
  # AC 9: "Genuinely empty turn still raises the timeout error, not return" ->
  #   Scenario: A genuinely empty turn raises the timeout error and does not return (@unit)
  #   Scenario: A genuinely empty turn raises the timeout error in JS and does not return (@unit)
  # AC 10: "Malformed arguments on no-audio path degrade gracefully without raising" ->
  #   Scenario: A tool-only turn with malformed function arguments returns without raising (@unit)
  #   Scenario: A tool-only JS turn with malformed function arguments returns without raising (@unit)
  # AC 11: "Full keyless suites in both SDKs stay green" ->
  #   Scenario: The full PY keyless realtime tool-call suite passes after the fix (@unit)
  #   Scenario: The full JS keyless realtime tool-call suite passes after the fix (@unit)
