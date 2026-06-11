Feature: OpenAI Realtime adapter guards response.create against in-flight responses
  As a developer testing a voice agent with the OpenAIRealtimeAgentAdapter
  I want recv_audio to suppress the premature response.create when a response is already active
  So that user audio arriving during an in-flight agent response does not race the server
  into a rejection or drain timeout

  # Issue #657 — recv_audio fires response.create unconditionally after
  # input_audio_buffer.commit, racing an active agent response into either a
  # server rejection ("Conversation already has an active response in progress")
  # or a silent-ignore that causes the drain loop to hit its deadline
  # (RuntimeError: TimeoutError).
  #
  # Root cause: the user-audio branch at line 407–411 lacks the
  # `not self._response_active` guard already present on the agent-turn branch
  # at line 423.  The fix adds the guard and defers response.create by setting
  # _deferred_response_create=True so the response.done handler fires it after
  # response.done clears _response_active.
  #
  # Scope guard (documented here, not a test scenario):
  #   AC-scope — manual-VAD only: this fix targets manual-VAD sessions
  #   (turn_detection: None, line 316). Server-VAD mode is explicitly OUT OF
  #   SCOPE.  No scenario exercises server-VAD behaviour; the PR must not claim
  #   correctness for server-VAD sessions.
  #
  # All scenarios use the hermetic _MockWS pattern from
  #   python/tests/voice/test_realtime_tool_calls.py — no live API key needed.

  Background:
    Given an OpenAIRealtimeAgentAdapter under test with a mock WebSocket (no live API key)
    And the adapter is in manual-VAD mode (turn_detection: None)
    And the adapter's response_timeout is set to a short value so tests complete quickly

  # ======================================================================
  # AC1 — guard present: response.create suppressed while response is active
  # ======================================================================

  @integration
  Scenario: Guard suppresses response.create when a response is already active
    # AC1: _response_active is True (mock pre-loaded with response.created, no
    # response.done yet).  Calling recv_audio with pending audio bytes must send
    # input_audio_buffer.commit but NOT response.create.
    Given the mock WebSocket has yielded "response.created" (no "response.done" yet)
    And the adapter's _pending_audio_bytes is greater than zero
    When recv_audio is called
    Then "input_audio_buffer.commit" IS present in mock_ws.sent
    And "response.create" is NOT present in mock_ws.sent

  # ======================================================================
  # AC2 — deferred response.create fires after response.done (ordering)
  # ======================================================================

  @integration
  Scenario: Deferred response.create fires after response.done is yielded, with ordering asserted
    # AC2: after the guard fires (response active), the mock then yields
    # response.done.  response.create must appear in mock_ws.sent AFTER the
    # index position of the response.done processing — ordering is asserted on
    # index positions, not mere presence.
    Given the mock WebSocket has yielded "response.created" then "response.done"
    And the adapter's _pending_audio_bytes is greater than zero
    When recv_audio is called and processes through "response.done"
    Then "response.create" IS present in mock_ws.sent
    And the index of "response.create" in mock_ws.sent is greater than the index of the send that follows "response.done" processing

  # ======================================================================
  # AC3 — single commit, single create across the full event sequence
  # ======================================================================

  @integration
  Scenario: Exactly one commit and one response.create appear across the full guarded sequence
    # AC3: across the full sequence (guard fires, response.done received, deferred
    # send fires), mock_ws.sent contains input_audio_buffer.commit exactly once
    # and response.create exactly once — no double-fire.
    Given the mock WebSocket has yielded "response.created" then "response.done"
    And the adapter's _pending_audio_bytes is greater than zero
    When recv_audio processes the full event sequence
    Then mock_ws.sent contains "input_audio_buffer.commit" exactly 1 time
    And mock_ws.sent contains "response.create" exactly 1 time

  # ======================================================================
  # AC4 — agent-turn branch unaffected
  # ======================================================================

  @integration
  Scenario: Agent-turn branch still sends response.create exactly once when no response is active
    # AC4: recv_audio with _agent_turn_pending=True and _response_active=False
    # must still fire response.create exactly once — the guard must not bleed
    # into the sibling branch.
    Given the adapter has _agent_turn_pending set to True
    And the adapter has _response_active set to False
    When recv_audio is called
    Then mock_ws.sent contains "response.create" exactly 1 time

  # ======================================================================
  # AC5 — no regression on normal path (no active response)
  # ======================================================================

  @integration
  Scenario: Normal path sends commit then response.create when no response is active
    # AC5: _pending_audio_bytes > 0 and _response_active=False — the common
    # uncontested path.  Both commit and create must fire as before.
    Given the adapter's _pending_audio_bytes is greater than zero
    And the adapter has _response_active set to False
    When recv_audio is called
    Then mock_ws.sent contains "input_audio_buffer.commit"
    And mock_ws.sent contains "response.create"
    And "input_audio_buffer.commit" appears before "response.create" in mock_ws.sent

  # ======================================================================
  # AC6 — explicit rejection face raises RuntimeError (falsifiable)
  # ======================================================================

  @integration
  Scenario: Explicit server rejection event raises RuntimeError
    # AC6: a _MockWS test that bypasses the guard (or runs against pre-fix code)
    # and injects the server error event "Conversation already has an active
    # response in progress" must surface as RuntimeError — not swallowed.
    # Evidence: pytest.raises(RuntimeError) assertion.
    Given the mock WebSocket will emit an error event with message "Conversation already has an active response in progress: resp_abc123"
    When the adapter processes the event
    Then a RuntimeError is raised
    And the RuntimeError message contains "Conversation already has an active response in progress"

  # ======================================================================
  # AC7 — timeout face eliminated: sequence that pre-fix triggers TimeoutError
  #        now returns a valid AudioChunk
  # ======================================================================

  @integration
  Scenario: Previously-timing-out sequence resolves to a valid AudioChunk after the fix
    # AC7: construct the exact race that pre-fix caused asyncio.TimeoutError:
    # response.created is yielded (response in flight), user audio arrives
    # (_pending_audio_bytes > 0), then the mock yields response.done followed
    # by the normal audio-delta sequence.  Pre-fix: response.create fires
    # immediately, the server's response.done never arrives in time, TimeoutError.
    # Post-fix: response.create is deferred until after response.done, then the
    # subsequent audio-delta sequence completes, and recv_audio returns a
    # non-empty AudioChunk without raising.
    Given the mock WebSocket has yielded "response.created" (simulating an in-flight response)
    And the adapter's _pending_audio_bytes is greater than zero
    And the mock WebSocket will subsequently yield "response.done" then audio delta events then a final "response.done"
    When recv_audio is called and the full sequence is processed
    Then recv_audio returns a non-empty AudioChunk
    And asyncio.TimeoutError is NOT raised

  # --- AC Coverage Map ---
  # AC1 — guard present: recv_audio does NOT send response.create when
  #        _response_active is True and _pending_audio_bytes > 0 ->
  #   Scenario: Guard suppresses response.create when a response is already active (@integration)
  #
  # AC2 — response.create deferred, not dropped (ordering): after response.done
  #        clears _response_active, response.create IS sent, ordering asserted
  #        on mock_ws.sent index positions ->
  #   Scenario: Deferred response.create fires after response.done is yielded, with ordering asserted (@integration)
  #
  # AC3 — single commit, single create: mock_ws.sent contains
  #        input_audio_buffer.commit exactly once and response.create exactly once ->
  #   Scenario: Exactly one commit and one response.create appear across the full guarded sequence (@integration)
  #
  # AC4 — agent-turn branch unaffected: recv_audio with _agent_turn_pending=True
  #        and _response_active=False still sends response.create exactly once ->
  #   Scenario: Agent-turn branch still sends response.create exactly once when no response is active (@integration)
  #
  # AC5 — no regression on normal path: _pending_audio_bytes > 0 and
  #        _response_active=False still sends commit then response.create as before ->
  #   Scenario: Normal path sends commit then response.create when no response is active (@integration)
  #
  # AC6 — explicit rejection face (falsifiable): injected server error event
  #        raises RuntimeError; pytest.raises assertion ->
  #   Scenario: Explicit server rejection event raises RuntimeError (@integration)
  #
  # AC7 — timeout face eliminated: sequence that pre-fix triggers
  #        asyncio.TimeoutError post-fix returns a valid AudioChunk without timing out ->
  #   Scenario: Previously-timing-out sequence resolves to a valid AudioChunk after the fix (@integration)
  #
  # AC-scope — manual VAD only: server-VAD sessions are OUT OF SCOPE.
  #        No scenario exercises server-VAD behaviour. Documented as a scope
  #        note in the feature header comment above, not as a runnable scenario,
  #        because no test can assert the absence of a claim across all VAD modes
  #        in a hermetic mock. The PR must not claim correctness for server-VAD.
