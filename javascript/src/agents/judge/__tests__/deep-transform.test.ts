import { describe, it, expect } from "vitest";

import { deepTransform } from "../deep-transform";

describe("deepTransform", () => {
  describe("when callback returns same value", () => {
    it("passes primitives through unchanged", () => {
      const identity = (v: unknown) => v;
      expect(deepTransform(42, identity)).toBe(42);
      expect(deepTransform("hello", identity)).toBe("hello");
      expect(deepTransform(true, identity)).toBe(true);
      expect(deepTransform(null, identity)).toBe(null);
      expect(deepTransform(undefined, identity)).toBe(undefined);
    });

    it("recurses into arrays", () => {
      const upper = (v: unknown) =>
        typeof v === "string" ? v.toUpperCase() : v;
      expect(deepTransform(["a", "b"], upper)).toEqual(["A", "B"]);
    });

    it("recurses into objects", () => {
      const upper = (v: unknown) =>
        typeof v === "string" ? v.toUpperCase() : v;
      expect(deepTransform({ x: "a", y: "b" }, upper)).toEqual({
        x: "A",
        y: "B",
      });
    });

    it("recurses into nested structures", () => {
      const upper = (v: unknown) =>
        typeof v === "string" ? v.toUpperCase() : v;
      const input = { arr: ["a"], obj: { nested: "b" } };
      expect(deepTransform(input, upper)).toEqual({
        arr: ["A"],
        obj: { nested: "B" },
      });
    });
  });

  describe("when callback returns different value", () => {
    it("stops recursion for that branch", () => {
      const replaceArrays = (v: unknown) =>
        Array.isArray(v) ? "[ARRAY]" : v;
      const input = { arr: ["a", "b"], str: "keep" };
      expect(deepTransform(input, replaceArrays)).toEqual({
        arr: "[ARRAY]",
        str: "keep",
      });
    });

    it("uses transformed value", () => {
      const double = (v: unknown) => (typeof v === "number" ? v * 2 : v);
      expect(deepTransform({ n: 5 }, double)).toEqual({ n: 10 });
    });
  });
});

