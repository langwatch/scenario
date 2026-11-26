import { describe, expect, it } from "vitest";
import {
  ScenarioEventType,
  scenarioEventSchema,
  scenarioMessageSnapshotSchema,
} from "../schema";

const snapshot = {
  type: ScenarioEventType.MESSAGE_SNAPSHOT,
  timestamp: 1,
  batchRunId: "batch-1",
  scenarioId: "scenario-1",
  scenarioRunId: "run-1",
  messages: [
    { id: "msg-1", role: "user", content: "What is the weather in Amsterdam?" },
    {
      id: "msg-2",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Amsterdam"}' },
        },
      ],
    },
    { id: "msg-3", role: "tool", content: "Sunny", toolCallId: "call-1" },
  ],
};

describe("scenarioMessageSnapshotSchema", () => {
  describe("when a snapshot carries user, assistant and tool messages", () => {
    it("keeps the scenario ids and every message", () => {
      const parsed = scenarioMessageSnapshotSchema.parse(snapshot);

      expect(parsed.scenarioRunId).toBe("run-1");
      expect(parsed.messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "tool",
      ]);
    });

    it("fills the default scenario set", () => {
      const parsed = scenarioMessageSnapshotSchema.parse(snapshot);

      expect(parsed.scenarioSetId).toBe("default");
    });

    it("is picked by the event union on its type", () => {
      const parsed = scenarioEventSchema.parse(snapshot);

      expect(parsed.type).toBe(ScenarioEventType.MESSAGE_SNAPSHOT);
    });
  });

  describe("when the scenario run id is missing", () => {
    it("refuses the snapshot", () => {
      const { scenarioRunId: _omitted, ...withoutRunId } = snapshot;

      expect(scenarioMessageSnapshotSchema.safeParse(withoutRunId).success).toBe(
        false,
      );
    });
  });

  describe("when a message has an unknown role", () => {
    it("refuses the snapshot", () => {
      const bad = {
        ...snapshot,
        messages: [{ id: "msg-1", role: "narrator", content: "Once upon a time" }],
      };

      expect(scenarioMessageSnapshotSchema.safeParse(bad).success).toBe(false);
    });
  });
});
