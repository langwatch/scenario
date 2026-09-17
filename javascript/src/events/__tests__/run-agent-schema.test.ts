// Ref: specs/agent-adapter-names.feature
import { describe, expect, it } from "vitest";
import { scenarioRunAgentSchema } from "../schema";

describe("scenarioRunAgentSchema", () => {
  describe("when the name holds a word", () => {
    it("takes it without the space around it", () => {
      const parsed = scenarioRunAgentSchema.parse({
        name: "  MyAgent  ",
        role: "agent",
      });

      expect(parsed.name).toBe("MyAgent");
    });
  });

  describe("when the name is blank", () => {
    it("refuses an empty name", () => {
      expect(() =>
        scenarioRunAgentSchema.parse({ name: "", role: "agent" }),
      ).toThrow();
    });

    it("refuses a name of space alone", () => {
      expect(() =>
        scenarioRunAgentSchema.parse({ name: "   ", role: "agent" }),
      ).toThrow();
    });
  });
});
