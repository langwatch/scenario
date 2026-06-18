Feature: TypeScript ElevenLabsAgentAdapter receiveAudio — keepalive-aware sliding idle deadline
  As a developer testing against a hosted ElevenLabs ConvAI agent
  I want receiveAudio to reset its timeout deadline on every inbound WS message (pings included)
  So that a slow-but-healthy agent that pings while processing does not trigger a spurious timeout

  Background:
    Given the ElevenLabsAgentAdapter is constructed with a webSocketFactory option that injects a FakeWebSocket
    And the adapter is connected — webSocketFactory has been called and an open event has been emitted on the FakeWebSocket

  # ============================================================
  # Group: Keepalive fix
  # ============================================================

  @unit
  Scenario: receiveAudio tolerates a silent-but-pinging stretch longer than timeout (AC-KA1)
    Given a FakeWebSocket connected to the adapter
    And the following timing constants are declared in the test:
      | constant    | value |
      | NUM_PINGS   | 8     |
      | PING_GAP_MS | 80    |
      | TIMEOUT_S   | 0.30  |
    And a static timing-invariant assertion: NUM_PINGS * PING_GAP_MS > TIMEOUT_S * 1000
    When receiveAudio(TIMEOUT_S) is called
    And 8 ping message events are emitted on the FakeWebSocket at real 80ms intervals
    And after all pings, a single audio message event carrying a PCM AudioChunk is emitted
    Then the receiveAudio promise resolves to the AudioChunk without throwing
    And the elapsed time from the receiveAudio call to resolution is greater than or equal to TIMEOUT_S * 1000 milliseconds
    And the test is RED on the current code (fixed setTimeout fires at 300ms before audio arrives)
    And the test is GREEN after the timerResetters sliding-idle-deadline change

  # ============================================================
  # Group: Dead-socket regression guard
  # ============================================================

  @unit
  Scenario: receiveAudio still times out on a truly silent socket after the keepalive change (AC-KA2)
    Given a FakeWebSocket connected to the adapter
    And no message events are emitted on the FakeWebSocket after connection
    When receiveAudio(0.30) is called
    Then the returned promise rejects with an Error whose message matches /timed out/
    And the rejection occurs in at least 300ms and no more than 450ms
    And this test is a no-regression guard: the pre-existing test at
      src/voice/adapters/__tests__/elevenlabs.test.ts ("receiveAudio rejects with timeout when no audio arrives in time")
      already covers this case; the AC guards the timerResetters change does not silently break it

  # ============================================================
  # Group: Full suite — no regression
  # ============================================================

  @unit
  Scenario: All existing adapter unit tests pass after the timerResetters change (AC-KA3)
    Given the timerResetters change has been applied to javascript/src/voice/adapters/elevenlabs.ts
    When npm test runs (vitest run, include: ['src/**/*.test.ts']) in the javascript/ directory
    Then the command exits 0
    And the vitest summary reports 0 failing tests
    And the run scope includes src/voice/adapters/__tests__/elevenlabs.test.ts, which contains 35 it-blocks
      covering onMessage branch handling, socket-error/close drainPendingWaiters drain,
      existing silent-timeout behavior, and the sendAudio path — the regression neighbors of the changed code

  # ============================================================
  # Group: Timer-leak cleanup on socket close/error
  # ============================================================

  @unit
  Scenario: A pending receiveAudio on socket close drains cleanly with no surviving timer (AC-KA5)
    Given a FakeWebSocket connected to the adapter
    And receiveAudio(5) has been called and its promise is pending
    When a close event is emitted on the FakeWebSocket before any audio arrives
    Then the receiveAudio promise resolves (not rejects) to the empty drain AudioChunk
    And no surviving timer fires after the drain — assert either:
      vi.getTimerCount() === 0 under fake timers,
      OR no late rejection or additional resolution fires within a real 100ms window after the drain
    And the timerResetters array is empty after the close (drainPendingWaiters spliced it)
    And this test exercises the same drainPendingWaiters call path as the existing socket-error test
      in src/voice/adapters/__tests__/elevenlabs.test.ts

  # ============================================================
  # Group: Live E2E (gated, non-blocking)
  # ============================================================

  @e2e @ts-elevenlabs
  Scenario: Live single-exchange happy path no longer times out intermittently (AC-KA4)
    Given ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, and OPENAI_API_KEY are all set
    When the greeting-led agent()→user→agent→judge test in
      javascript/tests/voice/elevenlabs-hosted.test.ts runs twice consecutively
    Then both runs complete without a receiveAudio timed out error
    And the vitest summary shows PASSED (not skipped) for both runs
    Note: this AC is explicitly waivable — if keys are unavailable (as documented in the
      repro-attempt: block of the issue), the waiver must be recorded in the prove-it Evidence block
      and AC-KA1 (the keyless mechanistic unit test) is the merge-gating proof

  # ============================================================
  # AC Coverage Map
  # ============================================================
  # AC-KA1 (receiveAudio tolerates pinging stretch longer than timeout — RED on current, GREEN after fix)
  #        -> Scenario: receiveAudio tolerates a silent-but-pinging stretch longer than timeout (AC-KA1)
  #
  # AC-KA2 (dead-socket still times out — regression guard against the keepalive change breaking the wall)
  #        -> Scenario: receiveAudio still times out on a truly silent socket after the keepalive change (AC-KA2)
  #
  # AC-KA3 (npm test exits 0, 0 failures, scope includes elevenlabs.test.ts 35 it-blocks)
  #        -> Scenario: All existing adapter unit tests pass after the timerResetters change (AC-KA3)
  #
  # AC-KA4 (live single-exchange passes twice consecutively, or explicitly waived with AC-KA1 as merge gate)
  #        -> Scenario: Live single-exchange happy path no longer times out intermittently (AC-KA4)
  #
  # AC-KA5 (socket close drains cleanly; timerResetters cleared; no surviving timer)
  #        -> Scenario: A pending receiveAudio on socket close drains cleanly with no surviving timer (AC-KA5)
