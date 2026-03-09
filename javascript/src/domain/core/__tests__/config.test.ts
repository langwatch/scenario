import { describe, it, expect } from "vitest";
import { scenarioProjectConfigSchema, defineConfig } from "../config";

describe("scenarioProjectConfigSchema", () => {
  describe("observability field", () => {
    it("accepts config without observability", () => {
      const result = scenarioProjectConfigSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts config with observability options", () => {
      const result = scenarioProjectConfigSchema.safeParse({
        observability: {
          serviceName: "my-service",
          instrumentations: [],
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts config with langwatch sub-config", () => {
      const result = scenarioProjectConfigSchema.safeParse({
        observability: {
          langwatch: {
            apiKey: "sk-lw-test",
            endpoint: "https://custom.endpoint",
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts config with empty observability object", () => {
      const result = scenarioProjectConfigSchema.safeParse({
        observability: {},
      });
      expect(result.success).toBe(true);
    });

    it("rejects string values for observability", () => {
      const result = scenarioProjectConfigSchema.safeParse({
        observability: "not-an-object",
      });
      expect(result.success).toBe(false);
    });

    it("rejects array values for observability", () => {
      const result = scenarioProjectConfigSchema.safeParse({
        observability: [{ serviceName: "test" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects unknown top-level keys due to strict mode", () => {
      const result = scenarioProjectConfigSchema.safeParse({
        unknownKey: "value",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("defineConfig", () => {
    it("returns the config as-is for type-safe authoring", () => {
      const config = defineConfig({
        headless: false,
        observability: {
          serviceName: "test",
          instrumentations: [],
        },
      });

      expect(config.observability).toEqual({
        serviceName: "test",
        instrumentations: [],
      });
    });
  });
});
