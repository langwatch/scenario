import { describe, it, expect } from "vitest";

import { EventReporter } from "../event-reporter";
import { ScenarioEventType, type ScenarioEvent } from "../schema";

/**
 * Build a MESSAGE_SNAPSHOT event whose message carries ARRAY content with an
 * OpenAI Realtime `input_audio` part.
 *
 * This is the runtime shape produced by `convertModelMessagesToAguiMessages`
 * (commit 180bab4): array content with audio translated to `input_audio` so
 * the langwatch ingest content-extractor can externalise the base64 bytes to
 * stored-objects. AG-UI's `MessagesSnapshotEventSchema` types message
 * `content` as `string`, so the array only exists at runtime — we cast at the
 * boundary exactly like the converter does. The langwatch ingest schema
 * accepts array content via `chatMessageSchema.content: union(string, array)`.
 */
function makeAudioSnapshotEvent(): ScenarioEvent {
  const arrayContent = [
    { type: "text", text: "Hello" },
    {
      type: "input_audio",
      input_audio: {
        data: "BASE64AUDIOBYTES",
        format: "wav",
        mimeType: "audio/wav",
      },
    },
  ];

  return {
    type: ScenarioEventType.MESSAGE_SNAPSHOT,
    timestamp: 1,
    batchRunId: "batch-1",
    scenarioId: "scenario-1",
    scenarioRunId: "run-1",
    scenarioSetId: "default",
    messages: [
      {
        id: "msg-1",
        role: "user",
        // Runtime carries an array post-180bab4; AG-UI types content as string.
        content: arrayContent as unknown as string,
      },
    ],
  } as unknown as ScenarioEvent;
}

/**
 * `processEventForApi` is private — exercise it through bracket access. This is
 * the transform applied to every event immediately before the POST body is
 * built in `postEvent`, so asserting its output asserts the wire shape.
 */
function processEventForApi(
  reporter: EventReporter,
  event: ScenarioEvent
): ScenarioEvent {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (reporter as any).processEventForApi(event);
}

describe("EventReporter.processEventForApi", () => {
  const reporter = new EventReporter({
    endpoint: "https://example.test",
    apiKey: "test-key",
  });

  it("passes ARRAY message content through without JSON.stringify-ing it (input_audio stays an array part)", () => {
    const event = makeAudioSnapshotEvent();

    const processed = processEventForApi(reporter, event);

    if (processed.type !== ScenarioEventType.MESSAGE_SNAPSHOT) {
      throw new Error("expected a MESSAGE_SNAPSHOT event");
    }

    const content = processed.messages[0].content as unknown;

    // Re-stringifying an array re-buries inline audio: the ingest extractor
    // walks ARRAY content only, so a JSON-string array is skipped and the
    // base64 persists inline (the 90 MB list-query bug). Content must stay an
    // array so the extractor can externalise the audio.
    expect(Array.isArray(content)).toBe(true);
    expect(typeof content).not.toBe("string");
    expect(content).toEqual([
      { type: "text", text: "Hello" },
      {
        type: "input_audio",
        input_audio: {
          data: "BASE64AUDIOBYTES",
          format: "wav",
          mimeType: "audio/wav",
        },
      },
    ]);
  });

  it("leaves plain string message content untouched", () => {
    const event = {
      type: ScenarioEventType.MESSAGE_SNAPSHOT,
      timestamp: 1,
      batchRunId: "batch-1",
      scenarioId: "scenario-1",
      scenarioRunId: "run-1",
      scenarioSetId: "default",
      messages: [{ id: "msg-1", role: "user", content: "just text" }],
    } as unknown as ScenarioEvent;

    const processed = processEventForApi(reporter, event);

    if (processed.type !== ScenarioEventType.MESSAGE_SNAPSHOT) {
      throw new Error("expected a MESSAGE_SNAPSHOT event");
    }

    expect(processed.messages[0].content).toBe("just text");
  });
});
