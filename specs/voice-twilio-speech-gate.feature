Feature: Twilio inbound speech admission
  Twilio sends media throughout a call, including silence.
  The Python adapter admits speech so the shared drain can end turns on a pause.

  @integration
  Scenario: Continuous quiet media does not keep a spoken turn open
    Given a Twilio stream containing speech followed by continuous quiet media
    When the adapter drains the response
    Then the turn ends on tail silence while the stream remains connected

  @unit
  Scenario: Speech retains its onset and short pauses
    Given the default 300 ms pre-roll and 400 ms hangover
    When speech follows quiet audio and contains a short quiet pause
    Then the onset includes the pre-roll in order
    And the short pause is admitted without starting another utterance

  @unit
  Scenario: A terminal chunk always reaches the consumer
    Given a gate holding quiet pre-roll
    When an empty terminal chunk arrives
    Then the terminal chunk is admitted and the per-call state is cleared

  @integration
  Scenario: Gate controls and counters follow the adapter lifecycle
    Given an adapter with a configured or disabled speech gate
    When calls are rearmed and the adapter disconnects
    Then pre-roll cannot leak between calls
    And disconnect reports gate enablement, dropped audio and speech onsets
