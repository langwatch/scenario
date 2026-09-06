import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { EventReporter } from "../event-reporter";
import {
  ScenarioEventType,
  type ScenarioEvent,
  type ScenarioRunStartedEvent,
} from "../schema";

vi.mock("../event-alert-message-logger", () => ({
  EventAlertMessageLogger: vi.fn().mockImplementation(function (this: unknown) {
    return { handleGreeting: vi.fn() };
  }),
}));

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

/** A base64 run long enough to be recognised as an audio payload. */
const LONG_BASE64_AUDIO = "QUJDRA".repeat(60);

/** The same snapshot shape, with an audio payload of realistic size. */
function makeLongAudioSnapshotEvent(): ScenarioEvent {
  const event = makeAudioSnapshotEvent() as unknown as {
    messages: { content: { input_audio?: { data: string } }[] }[];
  };
  const audioPart = event.messages[0]!.content[1]!;
  audioPart.input_audio!.data = LONG_BASE64_AUDIO;
  return event as unknown as ScenarioEvent;
}

function makeEvent(): ScenarioRunStartedEvent {
  return {
    type: ScenarioEventType.RUN_STARTED,
    batchRunId: "batch-1",
    scenarioId: "scenario-1",
    scenarioRunId: "run-1",
    scenarioSetId: "default",
    timestamp: Date.now(),
    metadata: { name: "test-name", description: "test-description" },
  };
}

function mockOkFetch() {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ url: "https://app.langwatch.ai/scenario/run-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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

describe("EventReporter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Authorization: Bearer and no X-Auth-Token", async () => {
    const fetchMock = mockOkFetch();
    const reporter = new EventReporter({
      endpoint: "https://app.langwatch.ai",
      apiKey: "test-api-key",
    });

    await reporter.postEvent(makeEvent());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.langwatch.ai/api/scenario-events");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-api-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Auth-Token"]).toBeUndefined();
    expect(headers["X-Project-Id"]).toBeUndefined();
  });

  it("sends X-Project-Id when projectId is configured", async () => {
    const fetchMock = mockOkFetch();
    const reporter = new EventReporter({
      endpoint: "https://app.langwatch.ai",
      apiKey: "test-api-key",
      projectId: "project_xxx",
    });

    await reporter.postEvent(makeEvent());

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-api-key");
    expect(headers["X-Project-Id"]).toBe("project_xxx");
  });

  it("omits X-Project-Id when projectId is an empty string", async () => {
    const fetchMock = mockOkFetch();
    const reporter = new EventReporter({
      endpoint: "https://app.langwatch.ai",
      apiKey: "test-api-key",
      projectId: "",
    });

    await reporter.postEvent(makeEvent());

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["X-Project-Id"]).toBeUndefined();
  });

  it("skips POST when apiKey is empty (avoids 401 storm)", async () => {
    const fetchMock = mockOkFetch();
    const reporter = new EventReporter({
      endpoint: "https://app.langwatch.ai",
      apiKey: undefined,
    });

    const result = await reporter.postEvent(makeEvent());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it("throws on a non-2xx response so the bus can retry, carrying the status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("boom", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const reporter = new EventReporter({
      endpoint: "https://app.langwatch.ai",
      apiKey: "test-api-key",
    });

    await expect(reporter.postEvent(makeEvent())).rejects.toMatchObject({
      status: 500,
    });
  });

  it("throws on a network failure so the bus can retry", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);
    const reporter = new EventReporter({
      endpoint: "https://app.langwatch.ai",
      apiKey: "test-api-key",
    });

    await expect(reporter.postEvent(makeEvent())).rejects.toThrow(
      "connection refused"
    );
  });

  it("succeeds after the bus retries a fetch that failed twice", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValue(
        new Response(JSON.stringify({ url: "https://app.langwatch.ai/s/run-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const reporter = new EventReporter({
      endpoint: "https://app.langwatch.ai",
      apiKey: "test-api-key",
    });

    await expect(reporter.postEvent(makeEvent())).rejects.toThrow("transient failure");
    await expect(reporter.postEvent(makeEvent())).rejects.toThrow("transient failure");
    const result = await reporter.postEvent(makeEvent());

    expect(result.setUrl).toBe("https://app.langwatch.ai/s/run-1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("treats a 2xx response with a body that is not JSON as delivered", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const reporter = new EventReporter({
      endpoint: "https://app.langwatch.ai",
      apiKey: "test-api-key",
    });

    const result = await reporter.postEvent(makeEvent());

    expect(result.setUrl).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps base64 audio out of the failure log", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const reporter = new EventReporter({
      endpoint: "https://app.langwatch.ai",
      apiKey: "test-api-key",
    });

    await expect(
      reporter.postEvent(makeLongAudioSnapshotEvent()),
    ).rejects.toMatchObject({ status: 500 });

    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).not.toContain(LONG_BASE64_AUDIO);
    expect(logged).toContain("b64 chars elided");
    errorLog.mockRestore();
  });

  it("returns setUrl from a successful response", async () => {
    mockOkFetch();
    const reporter = new EventReporter({
      endpoint: "https://app.langwatch.ai",
      apiKey: "test-api-key",
    });

    const result = await reporter.postEvent(makeEvent());

    expect(result.setUrl).toBe("https://app.langwatch.ai/scenario/run-1");
  });
});
