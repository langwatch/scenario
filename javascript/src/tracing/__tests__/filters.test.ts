import { describe, it, expect } from "vitest";
import { scenarioOnly, withCustomScopes } from "../filters";

describe("filters", () => {
  describe("scenarioOnly", () => {
    it("includes only @langwatch/scenario scope", () => {
      expect(scenarioOnly).toEqual([
        {
          include: {
            instrumentationScopeName: [{ equals: "@langwatch/scenario" }],
          },
        },
      ]);
    });

    it("returns a single-element array", () => {
      expect(scenarioOnly).toHaveLength(1);
    });
  });

  describe("withCustomScopes", () => {
    describe("when called with no additional scopes", () => {
      it("includes only @langwatch/scenario", () => {
        const filters = withCustomScopes();
        expect(filters).toEqual([
          {
            include: {
              instrumentationScopeName: [{ equals: "@langwatch/scenario" }],
            },
          },
        ]);
      });
    });

    describe("when called with one custom scope", () => {
      it("includes @langwatch/scenario and the custom scope", () => {
        const filters = withCustomScopes("my-app");
        expect(filters).toEqual([
          {
            include: {
              instrumentationScopeName: [
                { equals: "@langwatch/scenario" },
                { equals: "my-app" },
              ],
            },
          },
        ]);
      });
    });

    describe("when called with multiple custom scopes", () => {
      it("includes @langwatch/scenario and all custom scopes", () => {
        const filters = withCustomScopes("my-app", "my-agent", "my-tools");
        expect(filters).toEqual([
          {
            include: {
              instrumentationScopeName: [
                { equals: "@langwatch/scenario" },
                { equals: "my-app" },
                { equals: "my-agent" },
                { equals: "my-tools" },
              ],
            },
          },
        ]);
      });
    });

    it("returns a new array each time", () => {
      const a = withCustomScopes("a");
      const b = withCustomScopes("b");
      expect(a).not.toBe(b);
    });
  });
});
