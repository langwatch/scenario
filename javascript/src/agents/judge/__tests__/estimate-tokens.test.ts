import { describe, it, expect } from "vitest";
import { estimateTokens } from "../estimate-tokens";

describe("estimateTokens", () => {
  describe("when given an empty string", () => {
    it("returns 0", () => {
      expect(estimateTokens("")).toBe(0);
    });
  });

  describe("when given a string of 4000 characters", () => {
    it("returns approximately 1000 tokens", () => {
      const text = "a".repeat(4000);
      expect(estimateTokens(text)).toBe(1000);
    });
  });

  describe("when given a string of 8 ASCII characters", () => {
    it("returns 2 tokens using 4 bytes/token ratio", () => {
      expect(estimateTokens("abcdefgh")).toBe(2);
    });
  });

  describe("when given a string with odd byte length", () => {
    it("rounds up via Math.ceil", () => {
      // 5 bytes / 4 = 1.25, Math.ceil => 2
      expect(estimateTokens("abcde")).toBe(2);
    });
  });

  describe("when given multi-byte UTF-8 characters", () => {
    it("counts emojis as more tokens than their character count", () => {
      // Each emoji is 4 bytes in UTF-8, so 4 emojis = 16 bytes = 4 tokens
      const emojis = "\u{1F600}\u{1F601}\u{1F602}\u{1F603}";
      expect(emojis.length).toBe(8); // JS string length (UTF-16 surrogates)
      expect(estimateTokens(emojis)).toBe(4); // 16 bytes / 4
    });

    it("counts CJK characters as more tokens than ASCII", () => {
      // Each CJK character is 3 bytes in UTF-8
      const cjk = "\u4F60\u597D\u4E16\u754C"; // 你好世界
      expect(cjk.length).toBe(4); // JS string length
      expect(estimateTokens(cjk)).toBe(3); // 12 bytes / 4 = 3
    });
  });
});
