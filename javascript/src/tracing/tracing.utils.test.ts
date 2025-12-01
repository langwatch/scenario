import { describe, it, expect } from "vitest";
import { CoreMessage } from "ai";
import { TracingUtils } from "./tracing.utils";

describe("TracingUtils.formatTranscript", () => {
  describe("when messages array is empty", () => {
    it("returns empty string", () => {
      const result = TracingUtils.formatTranscript([]);
      expect(result).toBe("");
    });
  });

  describe("when messages have string content", () => {
    it("formats single message as role: JSON.stringify(content)", () => {
      const messages: CoreMessage[] = [{ role: "user", content: "hello" }];
      const result = TracingUtils.formatTranscript(messages);
      expect(result).toBe('user: "hello"');
    });

    it("formats multiple messages with newlines", () => {
      const messages: CoreMessage[] = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ];
      const result = TracingUtils.formatTranscript(messages);
      expect(result).toBe('user: "hi"\nassistant: "hello"');
    });
  });

  describe("when messages have complex content", () => {
    it("stringifies array content", () => {
      const messages: CoreMessage[] = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ];
      const result = TracingUtils.formatTranscript(messages);
      expect(result).toBe('user: [{"type":"text","text":"hello"}]');
    });

    it("includes system messages", () => {
      const messages: CoreMessage[] = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "hi" },
      ];
      const result = TracingUtils.formatTranscript(messages);
      expect(result).toBe('system: "You are helpful"\nuser: "hi"');
    });
  });
});

