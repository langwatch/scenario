/**
 * Guards the shared feature-path resolution.
 *
 * Twenty-two cucumber-bound suites now import their feature path from one
 * module, so a wrong answer here breaks all of them at once. It would break
 * them loudly, but as a parse error naming a path nobody wrote, which is a
 * long way from "the specs directory moved".
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, sep } from "node:path";

import { describe, it, expect } from "vitest";

import { VOICE_AGENTS_FEATURE } from "./features";

describe("given the shared feature-path helper", () => {
  describe("when a suite asks for the voice-agents feature", () => {
    it("resolves an absolute path that exists on disk", () => {
      expect(isAbsolute(VOICE_AGENTS_FEATURE)).toBe(true);
      expect(existsSync(VOICE_AGENTS_FEATURE)).toBe(true);
    });

    it("points at the repository's own voice-agents spec", () => {
      // Existence alone would be satisfied by any file the hops happen to
      // land on. Read it and check it is the feature the suites bind to.
      expect(basename(VOICE_AGENTS_FEATURE)).toBe("voice-agents.feature");
      expect(readFileSync(VOICE_AGENTS_FEATURE, "utf8")).toContain("Feature:");
    });

    it("resolves out of the javascript package, not inside it", () => {
      // The hop count is the thing that was duplicated 22 times and the thing
      // most likely to go wrong. specs/ sits at the repository root, above
      // javascript/, so a path still inside the package means one hop short.
      expect(VOICE_AGENTS_FEATURE.split(sep)).not.toContain("javascript");
    });
  });
});
