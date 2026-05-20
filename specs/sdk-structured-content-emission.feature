Feature: SDK emits structured message content as JSON arrays on the wire
  As a developer running voice (and other multimodal) scenarios against LangWatch
  I want the Python SDK to emit structured message content as real JSON arrays
  So that the LangWatch server can extract audio (and other parts) reliably
  Instead of relying on a fragile Python-repr string parser as the load-bearing path

  Background:
    Given a scenario test that emits SCENARIO_MESSAGE_SNAPSHOT events
    And the LangWatch server accepts both string and array content shapes

  @unit
  Scenario: Voice input_audio message round-trips as a JSON array
    Given a message with content equal to [{"type": "input_audio", "input_audio": {"data": "<b64>", "format": "wav"}}]
    When the SDK converts it via convert_messages_to_api_client_messages
    And the SCENARIO_MESSAGE_SNAPSHOT request body is captured at the httpx transport boundary
    Then messages[0].content in the JSON body is a JSON array (not a string)
    And the array's first element has "type" equal to "input_audio"
    And the array's first element has "input_audio.data" equal to "<b64>"
    And the array's first element has "input_audio.format" equal to "wav"
    And the body contains no single-quoted Python-repr substring for that content

  @unit
  Scenario: Text-only content still round-trips as a plain JSON string
    Given a message with content equal to "hello"
    When the SDK converts it via convert_messages_to_api_client_messages
    And the SCENARIO_MESSAGE_SNAPSHOT request body is captured at the httpx transport boundary
    Then messages[0].content in the JSON body is the JSON string "hello"
    And messages[0].content is not a JSON array
    And no existing string-content consumer needs to change

  @unit
  Scenario: Mixed multimodal parts in one message round-trip intact
    Given a message with content equal to [{"type": "text", "text": "describe this"}, {"type": "input_audio", "input_audio": {"data": "<b64>", "format": "wav"}}]
    When the SDK converts it via convert_messages_to_api_client_messages
    And the SCENARIO_MESSAGE_SNAPSHOT request body is captured at the httpx transport boundary
    Then messages[0].content in the JSON body is a JSON array with two elements
    And element 0 has "type" equal to "text" and "text" equal to "describe this"
    And element 1 has "type" equal to "input_audio" and "input_audio.format" equal to "wav"
    And ordering of elements is preserved as authored

  @unit
  Scenario: Byte-level wire payload verification for a voice turn
    Given a voice turn that produces a message via voice/messages.py create_audio_message
    When the SDK posts the SCENARIO_MESSAGE_SNAPSHOT event
    And the raw HTTP body bytes are intercepted at the httpx transport boundary
    Then the bytes parse as valid JSON
    And messages[*].content for the voice turn is a JSON array, not a JSON string
    And no Python-repr artifact (e.g. "[{'type':") appears anywhere in the body

  @integration
  Scenario: Generated client model accepts Union[str, list] for content without coercion
    Given the regenerated/patched generated client message-item models
    When a message-item is constructed with content as a list of dicts
    And the model is serialized via to_dict
    Then to_dict returns content as a Python list (not a stringified list)
    And from_dict accepts a list and preserves it as a list
    And the deviation marker comment is present so future regenerations are caught

  @integration
  Scenario: All four message role variants pass structured content through unchanged
    Given a structured-content list value
    When convert_messages_to_api_client_messages handles role "user"
    And convert_messages_to_api_client_messages handles role "assistant"
    And convert_messages_to_api_client_messages handles role "system"
    And convert_messages_to_api_client_messages handles role "tool"
    Then none of the four branches calls str() on a list-typed content
    And each role's emitted content equals the input list by value
    And the existing empty-content guard behavior is preserved for each role

  @e2e
  Scenario: Voice example produces a stored-object file reference end-to-end
    Given examples/voice/basic_greeting.py is run against LANGWATCH_ENDPOINT=https://app.langwatch.ai
    And langwatch/langwatch #4139 is deployed to production
    When the run completes and the extractor refs span is inspected
    Then at least one "/api/files/<id>" reference is present in the extractor refs span
    And no entries in the run indicate audio was dropped due to content-shape parse failure

# --- AC Coverage Map ---
# AC 1: "input_audio content emits as a real JSON array, not a Python-repr string"
#   -> @unit "Voice input_audio message round-trips as a JSON array"
#   -> @unit "Byte-level wire payload verification for a voice turn"
# AC 2: "Text-only messages still work; content=\"hello\" round-trips as string"
#   -> @unit "Text-only content still round-trips as a plain JSON string"
# AC 3: "Mixed multimodal in one message (text + input_audio) round-trips intact"
#   -> @unit "Mixed multimodal parts in one message round-trip intact"
# AC 4: "Unit test in python/tests/_events/ verifying the wire payload byte-for-byte"
#   -> @unit "Byte-level wire payload verification for a voice turn"
#   -> supported by @integration "Generated client model accepts Union[str, list]"
#   -> supported by @integration "All four message role variants pass structured content through unchanged"
# AC 5: "E2E: examples/voice/basic_greeting.py produces /api/files/<id> reference"
#   -> @e2e "Voice example produces a stored-object file reference end-to-end"
