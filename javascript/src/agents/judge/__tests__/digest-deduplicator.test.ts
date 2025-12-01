import { describe, it, expect, beforeEach } from "vitest";

import { DigestDeduplicator } from "../digest-deduplicator";

describe("DigestDeduplicator", () => {
  let deduplicator: DigestDeduplicator;

  beforeEach(() => {
    deduplicator = new DigestDeduplicator({ threshold: 50 });
  });

  describe("process", () => {
    describe("when processing strings", () => {
      it("returns short strings unchanged", () => {
        expect(deduplicator.process("short")).toBe("short");
      });

      it("returns first occurrence of long strings unchanged", () => {
        const long = "a".repeat(60);
        expect(deduplicator.process(long)).toBe(long);
      });

      it("returns duplicate marker for repeated long strings", () => {
        const long = "a".repeat(60);
        deduplicator.process(long);
        expect(deduplicator.process(long)).toBe("[DUPLICATE - SEE ABOVE]");
      });

      it("does not deduplicate short repeated strings", () => {
        deduplicator.process("short");
        expect(deduplicator.process("short")).toBe("short");
      });
    });

    describe("when processing numbers and booleans", () => {
      it("returns numbers unchanged", () => {
        expect(deduplicator.process(42)).toBe(42);
        expect(deduplicator.process(3.14)).toBe(3.14);
      });

      it("returns booleans unchanged", () => {
        expect(deduplicator.process(true)).toBe(true);
        expect(deduplicator.process(false)).toBe(false);
      });
    });

    describe("when processing null and undefined", () => {
      it("returns null unchanged", () => {
        expect(deduplicator.process(null)).toBe(null);
      });

      it("returns undefined unchanged", () => {
        expect(deduplicator.process(undefined)).toBe(undefined);
      });
    });

    describe("when processing arrays", () => {
      it("processes each element recursively", () => {
        const long = "b".repeat(60);
        const result = deduplicator.process([long, long, "short"]);
        expect(result).toEqual([long, "[DUPLICATE - SEE ABOVE]", "short"]);
      });

      it("preserves array structure with mixed types", () => {
        const result = deduplicator.process([1, "hello", true, null]);
        expect(result).toEqual([1, "hello", true, null]);
      });
    });

    describe("when processing objects", () => {
      it("processes each value recursively", () => {
        const long = "c".repeat(60);
        const result = deduplicator.process({
          first: long,
          second: long,
          short: "hi",
        });
        expect(result).toEqual({
          first: long,
          second: "[DUPLICATE - SEE ABOVE]",
          short: "hi",
        });
      });

      it("handles nested objects", () => {
        const long = "d".repeat(60);
        const result = deduplicator.process({
          outer: {
            inner: long,
          },
          also: long,
        });
        expect(result).toEqual({
          outer: {
            inner: long,
          },
          also: "[DUPLICATE - SEE ABOVE]",
        });
      });
    });

    describe("when processing JSON strings", () => {
      it("parses JSON and deduplicates nested content", () => {
        const long = "e".repeat(60);
        const json = JSON.stringify({ message: long });
        deduplicator.process(long); // Mark as seen
        const result = deduplicator.process(json);
        expect(result).toBe(
          JSON.stringify({ message: "[DUPLICATE - SEE ABOVE]" }),
        );
      });

      it("handles JSON arrays", () => {
        const long = "f".repeat(60);
        const json = JSON.stringify([{ content: long }, { content: long }]);
        const result = deduplicator.process(json);
        expect(result).toBe(
          JSON.stringify([
            { content: long },
            { content: "[DUPLICATE - SEE ABOVE]" },
          ]),
        );
      });

      it("leaves invalid JSON as plain string", () => {
        const notJson = "{not valid json";
        expect(deduplicator.process(notJson)).toBe(notJson);
      });
    });

    describe("when normalizing strings", () => {
      it("treats strings with different whitespace as duplicates", () => {
        const content1 = "g".repeat(30) + "\n\n" + "h".repeat(30);
        const content2 = "g".repeat(30) + " " + "h".repeat(30);
        deduplicator.process(content1);
        expect(deduplicator.process(content2)).toBe("[DUPLICATE - SEE ABOVE]");
      });

      it("treats strings with different case as duplicates", () => {
        const content1 =
          "HELLO WORLD THIS IS A LONG STRING FOR TESTING PURPOSES HERE";
        const content2 =
          "hello world this is a long string for testing purposes here";
        deduplicator.process(content1);
        expect(deduplicator.process(content2)).toBe("[DUPLICATE - SEE ABOVE]");
      });

      it("handles escaped newlines in JSON", () => {
        const content1 =
          "line1\\nline2\\nline3 with more content here to exceed threshold";
        const content2 =
          "line1 line2 line3 with more content here to exceed threshold";
        deduplicator.process(content1);
        expect(deduplicator.process(content2)).toBe("[DUPLICATE - SEE ABOVE]");
      });
    });
  });

  describe("reset", () => {
    it("clears seen content allowing duplicates again", () => {
      const long = "i".repeat(60);
      deduplicator.process(long);
      expect(deduplicator.process(long)).toBe("[DUPLICATE - SEE ABOVE]");

      deduplicator.reset();

      expect(deduplicator.process(long)).toBe(long);
    });
  });
});

