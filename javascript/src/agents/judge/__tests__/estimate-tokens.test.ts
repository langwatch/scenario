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

  describe("when given a string of 8 characters", () => {
    it("returns 2 tokens using 4 chars/token ratio", () => {
      expect(estimateTokens("abcdefgh")).toBe(2);
    });
  });

  describe("when given a string with odd length", () => {
    it("rounds up via Math.ceil", () => {
      // 5 chars / 4 = 1.25, Math.ceil => 2
      expect(estimateTokens("abcde")).toBe(2);
    });
  });
});
