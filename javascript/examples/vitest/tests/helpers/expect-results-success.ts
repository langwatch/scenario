import { expect } from "vitest";

export function expectResultsSuccess(result: { success: boolean }) {
  try {
    expect(result.success).toBe(true);
  } catch (error) {
    console.log(result);
    throw error;
  }
}
