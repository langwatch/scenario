import { expect } from "vitest";
import { ScenarioResult } from "@langwatch/scenario";

export function expectResultsSuccess(result: ScenarioResult) {
  try {
    expect(result.success).toBe(true);
  } catch (error) {
    console.log(result);
    throw error;
  }
}
