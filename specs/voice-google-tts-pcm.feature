Feature: Google TTS supplies raw PCM to voice scenarios
  Google LINEAR16 responses include a WAV container, while AudioChunk stores raw PCM16.

  @unit
  Scenario Outline: Google synthesis removes the WAV container before caching
    Given Google TTS returns 24 kHz mono PCM16 in a WAV container with <metadata>
    When I synthesize the same text and Google voice twice
    Then both AudioChunks contain only the original PCM samples
    And their duration excludes the WAV header and metadata
    And the Google provider is called only once

    Examples:
      | metadata           |
      | no extra chunks    |
      | an extra RIFF chunk |
