/**
 * The inconclusive-criteria contract on the run finished event: a criterion
 * the judge could not decide is reported apart from the ones it judged false,
 * and is always also one of the unmet criteria, so success stays "nothing
 * unmet" for every reader of the event.
 */
import { describe, it, expect } from "vitest";

import { scenarioResultsSchema, Verdict } from "../schema";

function results(overrides: Record<string, unknown>) {
  return {
    verdict: Verdict.FAILURE,
    metCriteria: ["Agent greets the user"],
    unmetCriteria: ["Agent looks up the order"],
    ...overrides,
  };
}

describe("given a results payload for the run finished event", () => {
  describe("when the inconclusive criteria are a subset of the unmet ones", () => {
    it("accepts the payload", () => {
      const parsed = scenarioResultsSchema.parse(
        results({ inconclusiveCriteria: ["Agent looks up the order"] })
      );

      expect(parsed.inconclusiveCriteria).toEqual([
        "Agent looks up the order",
      ]);
    });
  });

  describe("when the field is left out", () => {
    it("accepts the payload and leaves the field out", () => {
      const parsed = scenarioResultsSchema.parse(results({}));

      expect(parsed).not.toHaveProperty("inconclusiveCriteria");
    });
  });

  describe("when an inconclusive criterion is not among the unmet ones", () => {
    it("rejects the payload", () => {
      expect(() =>
        scenarioResultsSchema.parse(
          results({ inconclusiveCriteria: ["Agent greets the user"] })
        )
      ).toThrow(/also be in unmetCriteria/);
    });
  });

  describe("when the field is present but empty", () => {
    it("rejects the payload, since it is omitted rather than emptied", () => {
      expect(() =>
        scenarioResultsSchema.parse(results({ inconclusiveCriteria: [] }))
      ).toThrow();
    });
  });
});
