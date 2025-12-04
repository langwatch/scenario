import { describe, it, expect, beforeEach } from "vitest";

import { StringDeduplicator } from "../string-deduplicator";

describe("StringDeduplicator", () => {
  let deduplicator: StringDeduplicator;

  beforeEach(() => {
    deduplicator = new StringDeduplicator({ threshold: 50 });
  });

  describe("process", () => {
    describe("when string is below threshold", () => {
      it("returns short strings unchanged", () => {
        expect(deduplicator.process("short")).toBe("short");
      });

      it("does not deduplicate short repeated strings", () => {
        deduplicator.process("short");
        expect(deduplicator.process("short")).toBe("short");
      });
    });

    describe("when string is at or above threshold", () => {
      it("returns first occurrence unchanged", () => {
        const long = "a".repeat(60);
        expect(deduplicator.process(long)).toBe(long);
      });

      it("returns duplicate marker for repeated strings", () => {
        const long = "a".repeat(60);
        deduplicator.process(long);
        expect(deduplicator.process(long)).toBe("[DUPLICATE - SEE ABOVE]");
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

