Feature: TwilioAgentAdapter A-leg external-number dialing
  As a tester running a scenario against a real deployed voice agent
  I want to attach the Media Stream to the originated (A) leg instead of the callee (B) leg
  So that I can test a phone number I do not own, without touching its live webhook

  # Issue: https://github.com/langwatch/scenario/issues/762
  # Plan: plan-scenario-762.md
  #
  # Chosen approach: an explicit `attach_stream="a-leg"` mode originates the call with
  # inline TwiML <Connect><Stream> on our own leg, touching nothing on the callee (no
  # resolvePhoneNumberSid, no readVoiceUrl/writeVoiceUrl). Default `"b-leg"` mode is
  # unchanged. Guardrails ship WITH the capability: per-call nonce WS auth + callSid
  # correlation (Slice 2), max call duration via Twilio TimeLimit + adapter timer
  # (Slice 3), destination allowlist with explicit typed opt-in (Slice 4).
  #
  # For each slice, Python and JS emitted TwiML/REST bodies are identical golden
  # strings — a mirrored-implementation drift is caught by the same assertion shape
  # in both languages.

  @integration @ts-bound @ts-twilio-proto
  Scenario: AC1 - A-leg external mode originates with inline Connect+Stream and zero callee REST
    Given a connected adapter with a valid publicBaseUrl and attach_stream="a-leg"
    When placeCall(to=<external E.164>) runs
    Then the origination TwiML is exactly <Connect><Stream url="wss://.../twilio/stream">
    And the REST spy shows zero resolvePhoneNumberSid, readVoiceUrl, or writeVoiceUrl calls against the callee

  @integration @ts-bound @ts-twilio-proto
  Scenario: AC2 - Default b-leg mode keeps byte-identical TwiML and REST call sequence
    Given the default attach_stream="b-leg"
    When placeCall runs against an owned number
    Then the emitted B-leg origination TwiML equals the golden TwiML string
    And the callee REST call sequence is resolve_phone_number_sid, then read_voice_url, then write_voice_url(webhook)
    And on disconnect() the callee REST call sequence continues with write_voice_url(prior)

  @integration @ts-bound @ts-twilio-proto
  Scenario: AC3 - Internal mode does not fall back to external on a resolve error
    Given internal (b-leg) mode
    When resolvePhoneNumberSid throws a 404 or a 429/500
    Then the error surfaces to the caller
    And no external (a-leg) branch runs

  @integration @ts-bound @ts-twilio-proto
  Scenario: AC4 - External call leaves zero callee state to roll back
    Given an external call that has ended, whether successfully or with a failure
    When disconnect() runs
    Then zero writeVoiceUrl calls are made
    And the callee phone number SID and prior voice URL state stayed unset throughout the call

  @integration @ts-bound @ts-twilio-server
  Scenario: AC5 - Media stream socket rejects a missing or mismatched nonce
    Given external mode with a minted per-call nonce
    When a socket's start frame lacks the nonce or carries the wrong one
    Then the socket is closed and the stream-connected signal does not fire
    And a later socket presenting the correct nonce is the one that connects

  @integration @ts-bound @ts-twilio-server
  Scenario: AC6 - Media stream socket ignores frames from a non-matching callSid
    Given a live external placeCall with a known originated call SID
    When a start frame's callSid differs from the originated SID
    Then that frame is ignored
    And the connect promise resolves exactly once, on the matching SID

  @integration @ts-bound @ts-twilio-server
  Scenario: AC7 - Adapter tears down the call when max call duration elapses
    Given an external call whose stream never terminates on its own
    When the configured max-call-duration elapses
    Then the adapter ends the call via REST with Status=completed
    And the adapter closes the WebSocket
    And connect-timeout and max-duration behave as two independently-configurable values

  @integration @ts-bound @ts-twilio-proto
  Scenario: AC8 - Destination not on the allowlist is rejected before origination
    Given a-leg mode where "to" is not on allowed_callees, or allowed_callees is unset
    When placeCall runs
    Then it rejects before origination
    And zero Calls.create REST calls are made

  @integration @ts-bound @ts-twilio-tunnel
  Scenario: AC9 - Unreachable tunnel is rejected before origination
    Given a-leg mode with an unreachable publicBaseUrl
    When placeCall runs
    Then tunnel readiness is checked before origination
    And it rejects with TunnelNotReadyError having issued zero Calls.create REST calls

  @integration @ts-bound @ts-twilio-proto
  Scenario: AC10 - sendDtmf is rejected in a-leg mode without disturbing the stream
    Given a-leg mode with an active external call
    When sendDtmf is called
    Then it raises an "unsupported in external mode" error
    And no Calls/{sid}.json TwiML-replace POST is written
    And the active stream survives

  @e2e @ts-bound @ts-twilio-tunnel
  Scenario: AC11 - Bidirectional audio is captured live over a real external call
    Given NGROK_AUTHTOKEN (or the project's live-Twilio env vars) is set in the environment (otherwise skip)
    And real Twilio credentials, a live tunnel, and an external test number
    When a scenario runs in a-leg mode
    Then the callee-side capture shows a received-audio frame count greater than zero for the sendAudio direction
    And an STT transcript of the outbound prompt appears in that capture, or a saved dual-direction recording confirms both directions

  @unit @ts-twilio-server
  Scenario: AC14 - Ungated tripwire proves the a-leg bidirectional frame loop, unconditionally in CI
    Given a-leg mode with a mock socket presenting a correct nonce and a matching callSid
    When an inbound media frame arrives
    Then a decoded frame reaches receiveAudio
    When sendAudio is called
    Then exactly one outbound Twilio media frame is emitted for it

  @unit @ts-twilio-proto
  Scenario: AC13 - Minted nonce is unique per call and drawn from a CSPRNG
    Given two external placeCall invocations
    When each mints its nonce
    Then the two minted nonce values differ
    And each nonce matches the chosen byte length and charset of a CSPRNG-drawn value

  @unit @ts-twilio-proto
  Scenario: AC12 - Calls.create carries the configured TimeLimit as the Twilio-side duration backstop
    Given a-leg mode with a max-call-duration configured
    When placeCall originates the call
    Then the REST Calls.create body includes TimeLimit equal to the configured seconds

# --- AC Coverage Map ---
# AC1  - A-leg external mode core, zero callee REST -> Scenario: AC1 - A-leg external mode originates with inline Connect+Stream and zero callee REST
# AC2  - Default b-leg byte-identical (golden TwiML + REST sequence) -> Scenario: AC2 - Default b-leg mode keeps byte-identical TwiML and REST call sequence
# AC3  - No silent fallback to external on transient resolve error -> Scenario: AC3 - Internal mode does not fall back to external on a resolve error
# AC4  - disconnect() no-op, no persisted callee state -> Scenario: AC4 - External call leaves zero callee state to roll back
# AC5  - Nonce-gated WS auth -> Scenario: AC5 - Media stream socket rejects a missing or mismatched nonce
# AC6  - callSid correlation -> Scenario: AC6 - Media stream socket ignores frames from a non-matching callSid
# AC7  - Max call duration teardown -> Scenario: AC7 - Adapter tears down the call when max call duration elapses
# AC8  - Destination allowlist, default-deny -> Scenario: AC8 - Destination not on the allowlist is rejected before origination
# AC9  - Tunnel readiness probe before origination -> Scenario: AC9 - Unreachable tunnel is rejected before origination
# AC10 - sendDtmf blocked in a-leg mode -> Scenario: AC10 - sendDtmf is rejected in a-leg mode without disturbing the stream
# AC11 - Live bidirectional audio smoke (env-gated) -> Scenario: AC11 - Bidirectional audio is captured live over a real external call
# AC12 - Twilio-side TimeLimit backstop -> Scenario: AC12 - Calls.create carries the configured TimeLimit as the Twilio-side duration backstop
# AC13 - Per-call CSPRNG nonce uniqueness -> Scenario: AC13 - Minted nonce is unique per call and drawn from a CSPRNG
# AC14 - Ungated a-leg frame-loop tripwire (CI-unconditional pairing for AC11) -> Scenario: AC14 - Ungated tripwire proves the a-leg bidirectional frame loop, unconditionally in CI
